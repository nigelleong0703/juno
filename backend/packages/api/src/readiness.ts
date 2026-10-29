/**
 * Dependency readiness for the public API gateway.
 *
 * Readiness is not liveness: /healthz reports not-ready while a dependency the gateway needs to
 * serve real traffic is unreachable, so a load balancer stops routing to this process instead of
 * sending requests that would fail. The auth session database, the app-owned store when it holds
 * its own connection (the Store's own `probe`), the private agentd are both part of that set; auth
 * metadata (/auth/info) is deliberately not proof of readiness.
 *
 * Every probe is bounded and cancellable, not merely abandoned. When the bound expires the probe
 * signal is aborted and the production probes turn that into a real cancel: the auth query is
 * bounded by Postgres' own query_timeout and its checkout is destroyed (never returned half-read),
 * and the postgres.js query issues a real .cancel(). A hung database therefore frees its work each
 * poll instead of accumulating connections or server-side queries. Failures stay generic: neither
 * the public response nor the thrown error carries a URL, a password or upstream exception text.
 */

/** A probe that owns its work and must settle; aborting `signal` asks it to cancel that work. */
export type ReadinessProbe = (signal: AbortSignal) => Promise<void>;

export interface ReadinessDeps {
  /** Resolves when the session/auth database answers a trivial query. */
  checkAuthDb: ReadinessProbe;
  /** App-store probe when it holds a distinct connection; omitted when it shares the auth pool. */
  checkAppStore?: ReadinessProbe;
  /** Private agentd base URL; probed at GET /healthz. */
  agentdUrl: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Per-probe bound; a dependency that never answers within this window fails readiness. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Run one probe under a bound. On expiry the controller aborts so the probe cancels its real work;
 * the race still returns promptly if a probe ignores the signal. A probe that settles after the
 * race has already finished is observed by the race, so its late rejection never goes unhandled.
 */
async function bound(run: ReadinessProbe, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('readiness probe timed out'));
    }, timeoutMs);
  });
  try {
    await Promise.race([run(controller.signal), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Probe a health path by status only; the body is drained and never surfaced. */
function httpProbe(url: string, fetchFn: typeof fetch): ReadinessProbe {
  return async (signal) => {
    const response = await fetchFn(url, { method: 'GET', redirect: 'manual', signal });
    if (!response.ok) throw new Error('readiness probe returned a non-2xx status');
    await response.body?.cancel().catch(() => undefined);
  };
}

/** The pg client surface the auth probe uses; every checkout is released exactly once. */
export interface PgClientLike {
  query(config: { text: string; query_timeout?: number }): Promise<unknown>;
  release(destroy?: boolean | Error): void;
}

/** The pg pool surface the auth probe uses. */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

/** Per-query bound for the auth SELECT 1; kept under the readiness probe bound. */
export const AUTH_QUERY_TIMEOUT_MS = 1500;

/** Take a pool client without letting a hung checkout outlive the probe bound. */
async function checkout(pool: PgPoolLike, signal: AbortSignal): Promise<PgClientLike> {
  const pending = pool.connect();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(new Error('readiness probe aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    // A checkout that lands after we gave up must never stay checked out; drop it instead.
    void pending.then((client) => client.release(true), () => undefined);
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Bounded auth-pool probe: a real checkout, a SELECT 1 carrying Postgres' own read query_timeout,
 * and an abort that destroys the connection so an abandoned query is really cancelled rather than
 * returned to the pool half-read. The connection is released exactly once on every path.
 */
export function createAuthDbProbe(pool: PgPoolLike, queryTimeoutMs = AUTH_QUERY_TIMEOUT_MS): ReadinessProbe {
  return async (signal) => {
    const client = await checkout(pool, signal);
    let released = false;
    const releaseOnce = (destroy: boolean): void => {
      if (released) return;
      released = true;
      client.release(destroy);
    };
    const onAbort = (): void => releaseOnce(true);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await client.query({ text: 'SELECT 1', query_timeout: queryTimeoutMs });
      releaseOnce(false);
    } catch (error) {
      releaseOnce(true);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * Build the readiness callback the gateway runs on every /healthz request. A dependency that was
 * down and comes back is served again without a restart because nothing is cached here.
 */
export function createDependencyReadiness(deps: ReadinessDeps): () => Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkAppStore = deps.checkAppStore;
  const probes: ReadinessProbe[] = [
    deps.checkAuthDb,
    httpProbe(new URL('/healthz', deps.agentdUrl).toString(), fetchFn),
  ];
  if (checkAppStore) probes.push(checkAppStore);

  return async () => {
    const results = await Promise.allSettled(probes.map((probe) => bound(probe, timeoutMs)));
    const failed = results.some((result) => result.status === 'rejected');
    if (failed) throw new Error('dependency readiness check failed');
  };
}

