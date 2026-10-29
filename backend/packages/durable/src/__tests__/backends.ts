/** The database the runner suite runs on: an embedded Postgres with every migration applied; the runner's tables are emptied per open. */
import { closeScratchPostgres, scratchPostgresUrl } from '../../../db/src/__tests__/store-backends.js';
import { createStore } from '../../../db/src/index.js';
import type { DurableDb } from '../db.js';

export interface Backend {
  name: 'postgres';
  open(): Promise<{ db: DurableDb; close(): Promise<void> }>;
}

export const backends: Backend[] = [{
  name: 'postgres',
  open: async () => {
    const store = await createStore(await scratchPostgresUrl());
    const db = store.raw;
    if (db === undefined) throw new Error('store has no raw SQL access');
    for (const table of ['invocations', 'journal', 'objects', 'waits', 'invocation_lanes', 'durable_coordination']) await db.query(`DELETE FROM ${table}`);
    return { db, close: () => store.close() };
  },
}];

/** Stop the embedded Postgres the suites share; call from afterAll in each suite file. */
export const closeBackends = closeScratchPostgres;

export const eventually = async (check: () => Promise<void> | void, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};
