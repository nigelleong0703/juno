/**
 * Dependency readiness: the gateway must report 503 while a dependency it needs is down and
 * recover on its own once that dependency is healthy again. These tests drive the real probe
 * against isolated loopback endpoints (no live infra) plus the wired /healthz HTTP surface, and
 * pin the production config that supplies the private agentd URL.
 */
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';
import { createAuthDbProbe, createDependencyReadiness } from '../readiness.js';
import { parseApiConfig } from '../config.js';

const UPSTREAM = 'http://127.0.0.1:8788';
const SERVICE_TOKEN = 'service-token';

interface LoopbackServer {
  url: string;
  paths: string[];
  close: () => Promise<void>;
}

const opened: LoopbackServer[] = [];

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});

async function startLoopback(handle: (path: string) => number | 'hang'): Promise<LoopbackServer> {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    paths.push(path);
    const status = handle(path);
    if (status === 'hang') return;
    response.statusCode = status;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  const entry: LoopbackServer = {
    url: 'http://127.0.0.1:' + address.port,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  opened.push(entry);
  return entry;
}

/** Isolated loopback endpoint whose status per path is derived from `respond`. */
function startServer(respond: (path: string) => number): Promise<LoopbackServer> {
  return startLoopback(respond);
}

function testAuth(): ApiAuth {
  return {
    info: { mode: 'account', providers: ['credential'] },
    handle: async () => new Response('auth', { status: 200 }),
    resolve: async () => null,
  };
}

function readinessApp(readiness?: () => Promise<void>): ReturnType<typeof createApiApp> {
  return createApiApp({ auth: testAuth(), agentdUrl: UPSTREAM, internalToken: SERVICE_TOKEN, readiness });
}

describe('dependency readiness probes', () => {
  it('passes when every dependency answers and probes the private agentd health path', async () => {
    const agentd = await startServer(() => 200);
    let authChecks = 0;
    let storeChecks = 0;
    const readiness = createDependencyReadiness({
      checkAuthDb: async () => {
        authChecks += 1;
      },
      checkAppStore: async () => {
        storeChecks += 1;
      },
      agentdUrl: agentd.url,
    });

    await expect(readiness()).resolves.toBeUndefined();
    expect(agentd.paths).toEqual(['/healthz']);
    expect([authChecks, storeChecks]).toEqual([1, 1]);
  });

  it('fails when the app store probe rejects and keeps the error generic', async () => {
    const agentd = await startServer(() => 200);
    const readiness = createDependencyReadiness({
      checkAuthDb: async () => undefined,
      checkAppStore: async () => {
        throw new Error('password=hunter2 host=private.internal');
      },
      agentdUrl: agentd.url,
    });

    await expect(readiness()).rejects.toThrow('dependency readiness check failed');
    await readiness().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('private.internal');
      expect(message).not.toContain(agentd.url);
    });
  });

  it('fails when a dependency answers with a non-2xx status', async () => {
    const agentd = await startServer(() => 503);
    const readiness = createDependencyReadiness({
      checkAuthDb: async () => undefined,
      agentdUrl: agentd.url,
    });

    await expect(readiness()).rejects.toThrow('dependency readiness check failed');
  });

  it('fails promptly when a dependency hangs instead of holding the request open', async () => {
    const hanging = await startLoopback(() => 'hang');
    const readiness = createDependencyReadiness({
      checkAuthDb: async () => undefined,
      agentdUrl: hanging.url,
      timeoutMs: 50,
    });

    const startedAt = Date.now();
    await expect(readiness()).rejects.toThrow('dependency readiness check failed');
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('recovers on the next call once a dependency is healthy again', async () => {
    let healthy = false;
    const agentd = await startServer(() => (healthy ? 200 : 500));
    const readiness = createDependencyReadiness({
      checkAuthDb: async () => undefined,
      agentdUrl: agentd.url,
    });

    await expect(readiness()).rejects.toThrow('dependency readiness check failed');
    healthy = true;
    await expect(readiness()).resolves.toBeUndefined();
  });
});

describe('gateway /healthz http surface', () => {
  it('returns 503 with a safe body while a dependency is down and 200 once it recovers', async () => {
    let healthy = true;
    let checks = 0;
    const app = readinessApp(async () => {
      checks += 1;
      if (!healthy) throw new Error('connection to postgres://user:secret@db failed');
    });

    expect((await app.request('/healthz')).status).toBe(200);
    expect(checks).toBe(1);

    healthy = false;
    const failed = await app.request('/healthz');
    expect(failed.status).toBe(503);
    const body = await failed.text();
    expect(body).not.toContain('secret');
    expect(body).not.toContain('postgres://');
    expect(body).not.toContain('db failed');

    // Auth metadata is not readiness: it stays available while the gateway is not ready.
    expect((await app.request('/auth/info')).status).toBe(200);

    healthy = true;
    expect((await app.request('/healthz')).status).toBe(200);
    expect(checks).toBe(3);
  });

  it('stays a plain liveness check when no readiness callback is injected', async () => {
    const app = readinessApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('hung database probes are cancelled, not accumulated', () => {
  it('aborts both database callbacks on every run and leaves nothing pending', async () => {
    let pending = 0;
    let cancelled = 0;
    const probe = (signal: AbortSignal): Promise<void> => {
      expect(signal).toBeInstanceOf(AbortSignal);
      pending += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            pending -= 1;
            cancelled += 1;
            reject(new Error('cancelled'));
          },
          { once: true },
        );
      });
    };
    const readiness = createDependencyReadiness({
      checkAuthDb: probe,
      checkAppStore: probe,
      agentdUrl: 'http://agentd.test',
      timeoutMs: 10,
      fetchFn: async () => new Response('{}'),
    });

    for (let run = 0; run < 3; run += 1) {
      await expect(readiness()).rejects.toThrow('dependency readiness check failed');
      expect(pending).toBe(0);
    }
    expect(cancelled).toBe(6);
  });

  it('observes a probe that settles late after the bound without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let failLate: (error: unknown) => void = () => undefined;
      const late = new Promise<void>((_resolve, reject) => {
        failLate = reject;
      });
      const readiness = createDependencyReadiness({
        // Ignores the signal and only settles once the test rejects it, after the bound expired.
        checkAuthDb: () => late,
        agentdUrl: 'http://agentd.test',
        timeoutMs: 10,
        fetchFn: async () => new Response('{}'),
      });

      await expect(readiness()).rejects.toThrow('dependency readiness check failed');
      failLate(new Error('late failure after the bound'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('production database probes', () => {
  const pass = new AbortController().signal;

  it('bounds the auth SELECT 1 with a real query timeout and releases the checkout once', async () => {
    const queries: Array<{ text: string; query_timeout?: number }> = [];
    const releases: Array<boolean | Error | undefined> = [];
    const client = {
      query: async (config: { text: string; query_timeout?: number }) => {
        queries.push(config);
      },
      release: (destroy?: boolean | Error) => {
        releases.push(destroy);
      },
    };
    const pool = { connect: async () => client };

    await createAuthDbProbe(pool, 500)(pass);
    expect(queries).toEqual([{ text: 'SELECT 1', query_timeout: 500 }]);
    expect(releases).toEqual([false]);
  });

  it('destroys the auth checkout instead of returning it when the probe is aborted', async () => {
    const releases: Array<boolean | Error | undefined> = [];
    let failQuery: (error: unknown) => void = () => undefined;
    const client = {
      query: () =>
        new Promise<void>((_resolve, reject) => {
          failQuery = reject;
        }),
      release: (destroy?: boolean | Error) => {
        releases.push(destroy);
        if (destroy === true) failQuery(new Error('connection destroyed'));
      },
    };
    const pool = { connect: async () => client };
    const controller = new AbortController();

    const running = createAuthDbProbe(pool, 500)(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(running).rejects.toThrow('connection destroyed');
    expect(releases).toEqual([true]);
  });
});
describe('production readiness wiring config', () => {
  const base = { INTERNAL_AGENTD_TOKEN: 'service-token' };

  it('rejects a non-http agentd URL', () => {
    expect(() => parseApiConfig({ ...base, AGENTD_URL: 'not-a-url' })).toThrow();
  });
});
