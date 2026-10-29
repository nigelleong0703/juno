/**
 * The single-instance lock of agentd (docs/BACKEND.md §2.2). agentd assumes it is the only process on its
 * database: the durable runner re-queues every `running` invocation on boot, and the channel gateways, the
 * meet watcher, push and event pruning are process-wide singletons. Two agentds at once (an accidental double
 * start, an overlapping deploy) would double-run invocations and open two gateway sessions, so the process
 * takes this lock before anything stateful starts and a second one waits until the first lets go.
 *
 * - Postgres: a session advisory lock held on one dedicated connection for the process lifetime. It needs a
 *   direct (session-mode) connection: PgBouncer in transaction mode, or a provider's pooled endpoint, hands
 *   the session to other clients and silently breaks session advisory locks, so DATABASE_URL must be the
 *   direct endpoint. Closing the connection (graceful stop, crash, SIGKILL) releases it.
 * - No database URL (memory store): nothing to protect, no lock.
 */
import postgres from 'postgres';
import { createLogger } from '@agent-desktop/log';

const log = createLogger({ service: 'db' });

/** 'junoagnt' as a 64-bit integer: the fixed advisory lock key (advisory locks are per database). */
const AGENTD_LOCK_KEY = 0x6a756e6f61676e74n;
const DEFAULT_RETRY_MS = 2000;
/** While waiting, log on the first attempt and then about every 20 s, not on every retry. */
const LOG_EVERY_ATTEMPTS = 10;

export interface InstanceLock {
  /** Let go of the lock; the next waiter can take it as soon as this resolves. Safe to call twice. */
  release(): Promise<void>;
}

const NO_LOCK: InstanceLock = { release: async () => undefined };

/** One try on Postgres: the lock, or null when another session holds it. A connection failure throws. */
export async function tryLockPostgres(databaseUrl: string, onLost: (reason: string) => void): Promise<InstanceLock | null> {
  let released = false;
  const sql = postgres(databaseUrl, {
    max: 1,
    // The default recycles a connection after 30-60 minutes; this one must live as long as the process.
    max_lifetime: null,
    fetch_types: false,
    onnotice: () => undefined,
    connection: { application_name: 'juno-agentd-lock' },
    onclose: () => { if (!released) onLost('lock connection closed'); },
  });
  try {
    const rows = await sql.unsafe<Array<{ locked: boolean }>>(`select pg_try_advisory_lock(${String(AGENTD_LOCK_KEY)}) as locked`);
    if (rows[0]?.locked === true) {
      return {
        async release() {
          if (released) return;
          released = true;
          // Unlock first so the lock is free when this returns, then close the connection.
          await sql.unsafe(`select pg_advisory_unlock(${String(AGENTD_LOCK_KEY)})`).catch(() => undefined);
          await sql.end();
        },
      };
    }
  } catch (error) {
    released = true;
    await sql.end().catch(() => undefined);
    throw error;
  }
  released = true;
  await sql.end();
  return null;
}

export interface InstanceLockOptions {
  /** Called if the held Postgres connection errors or closes. The process must not keep running without the lock: exit. */
  onLost: (reason: string) => void;
  /** Pause between attempts while another agentd holds the lock. */
  retryMs?: number;
}

/**
 * Take the lock for `databaseUrl`, waiting (and starting nothing) until the current holder lets go. Hold it for
 * the process lifetime and `release()` it on stop.
 */
export async function acquireInstanceLock(databaseUrl: string | undefined, options: InstanceLockOptions): Promise<InstanceLock> {
  if (!databaseUrl) return NO_LOCK;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  for (let attempt = 0; ; attempt += 1) {
    const lock = await tryLockPostgres(databaseUrl, options.onLost);
    if (lock !== null) {
      if (attempt > 0) log.info('Instance lock acquired');
      return lock;
    }
    if (attempt % LOG_EVERY_ATTEMPTS === 0) log.warn({ retryMs }, 'Another agentd holds the instance lock; waiting');
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
