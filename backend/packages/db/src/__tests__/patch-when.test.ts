/**
 * `patchWhen` is the compare-and-set execution workers and the coordinator rely on when both may change one row (a request the
 * user decides while a run withdraws it, a background task that finishes while it is stopped). Two store connections stand in
 * for two processes: the row lock must let exactly one of two conflicting writers win, every time.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { patchWhen } from '@agent-desktop/contracts';
import { closeScratchPostgres, scratchPostgresUrl, uid } from './store-backends';
import { createPostgresStore } from '../postgres-store.js';

afterAll(closeScratchPostgres);

const OPEN = 'open';

describe('patchWhen on Postgres', () => {
  it('lets exactly one of two concurrent conflicting writers change the row', async () => {
    const url = await scratchPostgresUrl();
    const coordinator = await createPostgresStore(url);
    const worker = await createPostgresStore(url);
    try {
      for (let round = 0; round < 25; round += 1) {
        const id = uid('agent');
        await coordinator.put('agents', { id, name: id, ownerId: 'user-1', handle: id, description: OPEN });
        const [fromCoordinator, fromWorker] = await Promise.all([
          patchWhen(coordinator, 'agents', id, (current) => current.description === OPEN, { description: 'decided by the coordinator' }),
          patchWhen(worker, 'agents', id, (current) => current.description === OPEN, { description: 'withdrawn by the worker' }),
        ]);
        const winners = [fromCoordinator, fromWorker].filter((doc) => doc !== undefined);
        expect(winners, `round ${String(round)}: one writer wins`).toHaveLength(1);
        expect((await coordinator.get('agents', id))?.description).toBe(winners[0]?.description);
      }
    } finally {
      await coordinator.close();
      await worker.close();
    }
  });

  it('leaves a row that no longer matches, and one that is gone, untouched', async () => {
    const url = await scratchPostgresUrl();
    const store = await createPostgresStore(url);
    try {
      const id = uid('agent');
      await store.put('agents', { id, name: id, ownerId: 'user-1', handle: id, description: 'closed' });
      expect(await patchWhen(store, 'agents', id, (current) => current.description === OPEN, { description: 'late' })).toBeUndefined();
      expect((await store.get('agents', id))?.description).toBe('closed');
      expect(await patchWhen(store, 'agents', uid('missing'), () => true, { description: 'nothing' })).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});
