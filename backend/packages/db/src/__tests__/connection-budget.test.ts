/**
 * The Postgres connection budget (BACKEND 2.2c): the arithmetic, and the start-time check against a real server's
 * max_connections, which fails with the formula instead of leaving "too many clients" for the first burst of work.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { assertConnectionBudget, ConnectionBudgetError, plannedConnections, readServerLimits } from '../connection-budget.js';
import { closeScratchPostgres, scratchPostgresUrl } from './store-backends';
import { createPostgresStore } from '../postgres-store.js';

afterAll(closeScratchPostgres);

const base = { coordinatorPool: 12, workers: 2, workerPool: 8, apiPool: 20, memorydPool: 10 };

describe('connection budget', () => {
  it('adds the pools and the connections outside them', () => {
    // coordinator 12 + 3, two workers 2 x (8 + 1), api 20, memoryd 10, headroom 5
    expect(plannedConnections(base).total).toBe(15 + 18 + 20 + 10 + 5);
    expect(plannedConnections({ ...base, coordinatorPool: 0, workers: 0 }).total).toBe(20 + 10 + 5);
  });

  it('accepts a deployment that fits and refuses one that does not, naming each consumer', async () => {
    const store = await createPostgresStore(await scratchPostgresUrl(), { poolMax: 3 });
    try {
      const limits = await readServerLimits(store.raw);
      expect(limits.maxConnections).toBeGreaterThan(0);
      const fits = await assertConnectionBudget(store.raw, base, { pool: 3, extra: 1 });
      expect(fits.total).toBe(plannedConnections(base).total);

      const tooManyWorkers = { ...base, workers: 12 };
      const error = await assertConnectionBudget(store.raw, tooManyWorkers, { pool: 3, extra: 1 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConnectionBudgetError);
      const message = (error as Error).message;
      expect(message).toContain('max_connections ' + String(limits.maxConnections));
      expect(message).toContain('workers: 12 x (pool 8 + 1');
      expect(message).toContain('AGENTD_WORKER_DB_POOL_MAX');
    } finally {
      await store.close();
    }
  });

  it('refuses a process whose own connections do not fit in what is free now', async () => {
    const store = await createPostgresStore(await scratchPostgresUrl(), { poolMax: 3 });
    try {
      const error = await assertConnectionBudget(store.raw, { ...base, workers: 0, apiPool: 0, memorydPool: 0 }, { pool: 500, extra: 1 }).catch((caught: unknown) => caught);
      expect((error as Error).message).toContain('This process needs up to 501 Postgres connections');
    } finally {
      await store.close();
    }
  });

  it('opens no more connections than its pool and one LISTEN', async () => {
    const store = await createPostgresStore(await scratchPostgresUrl(), { poolMax: 4 });
    try {
      const unlisten = await store.raw.listen?.('budget_probe', () => undefined);
      await Promise.all(Array.from({ length: 30 }, () => store.sql`SELECT pg_sleep(0.05)`));
      const [row] = await store.sql<Array<{ n: string }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND datname = current_database()`;
      // The pool (4) + the LISTEN connection (1); never the driver's default of 10.
      expect(Number(row?.n)).toBeLessThanOrEqual(4 + 1);
      await unlisten?.();
    } finally {
      await store.close();
    }
  });
});
