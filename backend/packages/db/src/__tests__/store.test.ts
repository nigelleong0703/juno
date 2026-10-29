/**
 * The Store contract, run against every implementation (memory, and Postgres on an embedded cluster).
 * Ids are unique per run because Postgres keeps its rows; event assertions are relative to the log head for the same reason.
 */
import { afterAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { NotFoundError } from '@agent-desktop/contracts';
import type { Run } from '@agent-desktop/public-contracts';
import { backends, closeScratchPostgres, eventually, uid, type TestStore } from './store-backends';

afterAll(closeScratchPostgres);

function agentDoc(id: string, ownerId = 'user-1') {
  return { id, name: 'Agent ' + id, ownerId, handle: id, description: 'A test agent' };
}

describe.each(backends)('Store ($name)', (backend) => {
  let store: TestStore;
  let close: () => Promise<void>;
  beforeEach(async () => { ({ store, close } = await backend.open()); });
  afterEach(() => close());

  it('answers the readiness probe', async () => {
    if (store.probe) await expect(store.probe(new AbortController().signal)).resolves.toBeUndefined();
  });

  it('should put and get a doc', async () => {
    const doc = agentDoc(uid('agent'));
    await store.put('agents', doc);
    expect(await store.get('agents', doc.id)).toEqual(doc);
  });

  it('should patch a doc', async () => {
    const doc = agentDoc(uid('agent'));
    await store.put('agents', doc);
    await store.patch('agents', doc.id, { name: 'Updated' });
    expect((await store.get('agents', doc.id))?.name).toBe('Updated');
  });

  it('should throw NotFoundError on patch of non-existent doc', async () => {
    await expect(store.patch('agents', uid('nonexistent'), { name: 'Updated' })).rejects.toThrow(NotFoundError);
  });

  it('should list docs with filtering', async () => {
    const ids = [uid('agent'), uid('agent'), uid('agent')];
    for (const id of ids) await store.put('agents', agentDoc(id));
    const page = await store.list('agents', { where: { ids: ids.slice(0, 2) } });
    expect(page.items.map((a) => a.id).sort()).toEqual(ids.slice(0, 2).sort());
  });

  it('should emit and receive events', async () => {
    const events: Array<{ id: number; event: { type: string } }> = [];
    const unsub = await store.eventBus.subscribe((e) => events.push(e));
    const before = (await store.eventBus.head?.()) ?? 0;
    await store.emit({ type: 'agent.status', agentId: uid('agent'), status: 'idle' });
    await eventually(() => expect(events).toHaveLength(1));
    expect(events[0].event.type).toBe('agent.status');
    expect(events[0].id).toBeGreaterThan(before);
    unsub();
  });

  it('should replay events with since()', async () => {
    const base = (await store.eventBus.head?.()) ?? 0;
    await store.emit({ type: 'agent.status', agentId: uid('agent'), status: 'idle' });
    await store.emit({ type: 'agent.status', agentId: uid('agent'), status: 'idle' });

    const replay = await store.eventBus.since(base);
    expect(replay).toHaveLength(2);
    expect(replay[1].id).toBeGreaterThan(replay[0].id);
    expect(await store.eventBus.since(replay[0].id)).toHaveLength(1);

    // head() is the global max id, and the owner-scoped view reports the same global head.
    expect(await store.eventBus.head?.()).toBe(replay[1].id);
    expect(await store.eventBus.forOwner?.('someone-else')?.head?.()).toBe(replay[1].id);
  });

  it('should support transactions', async () => {
    const doc = agentDoc(uid('agent'));
    const result = await store.tx(async (tx) => {
      await tx.put('agents', doc);
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(await store.get('agents', doc.id)).toBeDefined();
  });

  it('keeps both fields when two patches race on the same row', async () => {
    // Regression: patch was an unlocked read-merge-write, so a concurrent patch could silently drop
    // the other's field (an approval's awakeable id was lost this way and the run waited forever).
    const owner = uid('race-owner');
    for (const scope of [store, store.forOwner ? store.forOwner(owner) : store]) {
      for (let i = 0; i < 15; i += 1) {
        const id = uid('agent-race') + (scope === store ? '-base' : '-scoped');
        await scope.put('agents', { id, ownerId: owner, name: 'n', handle: 'h', title: 't' } as never);
        await Promise.all([
          scope.patch('agents', id, { name: 'name-' + String(i) } as never),
          scope.patch('agents', id, { title: 'title-' + String(i) } as never),
        ]);
        const row = await scope.get('agents', id);
        expect(row?.name).toBe('name-' + String(i));
        expect(row?.title).toBe('title-' + String(i));
      }
    }
  });

  // Known difference: the memory store does not break timestamp ties by id the way the SQL stores do.
  it.skipIf(backend.name === 'memory')('combines filters and pages equal timestamps without duplicates', async () => {
    const agentId = uid('agent-page'), conversationId = uid('conv-page'), parentId = uid('parent-page');
    const makeRun = (id: string): Run => ({
      id, agentId, conversationId, title: 'Needle',
      kind: 'chat', status: 'running', steps: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0, computeSeconds: 0 },
      startedAt: '2026-10-05T00:00:00.000Z', lastActivityAt: '2026-10-05T00:00:00.000Z',
    });
    const ids = ['page-a', 'page-b', 'page-c'].map((id) => uid(id)).sort();
    for (const id of ids) await store.put('runs', makeRun(id), { parentId });
    const where = { ids, agentId, conversationId, status: 'running', kind: 'chat', parentId };
    for (const order of ['asc', 'desc'] satisfies Array<'asc' | 'desc'>) {
      const first = await store.list('runs', { where, orderBy: 'at', order, limit: 1 });
      expect(first.nextCursor).toBeDefined();
      const rest = await store.list('runs', { where, orderBy: 'at', order, cursor: first.nextCursor, limit: 10 });
      expect([...first.items, ...rest.items].map(r => r.id)).toEqual(order === 'asc' ? ids : [...ids].reverse());
      expect(rest.nextCursor).toBeUndefined();
    }
    expect((await store.list('runs', { where: { ...where, status: 'completed' } })).items).toEqual([]);
    expect((await store.list('runs', { where: { ids: [] } })).items).toEqual([]);
    await store.patch('runs', ids[0], { title: 'Changed' });
    expect((await store.list('runs', { where: { ids: [ids[0]], parentId } })).items).toHaveLength(1);
    for (const id of ids) await store.delete('runs', id);
    expect((await store.list('runs', { where: { ids } })).items).toEqual([]);
  });

  // The memory store has no rollback: it applies writes immediately.
  it.skipIf(backend.name === 'memory')('rolls back writes and drops events when a transaction fails', async () => {
    const doc = agentDoc(uid('agent'));
    const base = (await store.eventBus.head?.()) ?? 0;
    const seen: number[] = [];
    const unsub = await store.eventBus.subscribe((e) => seen.push(e.id));
    await expect(store.tx(async (tx) => {
      await tx.put('agents', doc);
      await tx.emit({ type: 'agent.status', agentId: doc.id, status: 'idle' });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // A caught inner failure rolls back only the inner part.
    const kept = agentDoc(uid('agent'));
    await store.tx(async (tx) => {
      await tx.put('agents', kept);
      await tx.tx(async (inner) => { await inner.put('agents', doc); throw new Error('inner'); }).catch(() => undefined);
    });
    expect(await store.get('agents', doc.id)).toBeNull();
    expect(await store.get('agents', kept.id)).not.toBeNull();
    expect(await store.eventBus.since(base)).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen).toEqual([]);
    unsub();
  });
});

describe.each(backends)('Store row locks ($name)', (backend) => {
  let raw: TestStore;
  let close: () => Promise<void>;
  beforeEach(async () => { ({ store: raw, close } = await backend.open()); });
  afterEach(() => close());

  it('holds the lock until the tx body returns', async () => {
    const id = uid('a'), owner = uid('u');
    const store = raw.forOwner!(owner);
    await store.put('agents', { id, ownerId: owner, name: 'n', handle: 'h' });
    await store.tx(async (tx) => {
      expect((await tx.getForUpdate!('agents', id))?.id).toBe(id);
      await tx.patch('agents', id, { name: 'locked' });
    });
    expect((await store.get('agents', id))?.name).toBe('locked');
  });

  it('relocks a held row in the same transaction without deadlocking', async () => {
    const id = uid('a'), owner = uid('u');
    const store = raw.forOwner!(owner);
    await store.put('agents', { id, ownerId: owner, name: 'n', handle: 'h' });
    await store.tx(async (tx) => {
      expect((await tx.getForUpdate!('agents', id))?.id).toBe(id);
      expect((await tx.getForUpdate!('agents', id))?.id).toBe(id);
    });
  });

  it('synchronizes raw and scoped sections on the same physical row', async () => {
    const id = uid('a'), owner = uid('u');
    const store = raw.forOwner!(owner);
    await store.put('agents', { id, ownerId: owner, name: 'n', handle: 'h' });
    const order: string[] = [];
    const hold = async (name: string, target: typeof store): Promise<void> =>
      target.tx(async (tx) => {
        await tx.getForUpdate!('agents', id);
        order.push(name + '-in');
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(name + '-out');
      });
    await Promise.all([hold('raw', raw), hold('scoped', store)]);
    expect(order).toEqual(['raw-in', 'raw-out', 'scoped-in', 'scoped-out']);
  });

  it.skipIf(backend.name === 'memory')('refuses getForUpdate outside a transaction', async () => {
    const store = raw.forOwner!(uid('u'));
    await expect(store.getForUpdate?.('subscriptions', 'x')).rejects.toThrow(/transaction/);
    await expect(raw.getForUpdate?.('subscriptions', 'x')).rejects.toThrow(/transaction/);
  });

  it('blocks a second locker until the first transaction commits', async () => {
    const owner = uid('row-lock'), sub = uid('row-lock-sub');
    const store = raw.forOwner!(owner);
    await store.put('subscriptions', {
      id: sub, agentId: 'agent', conversationId: 'chat', filter: { source: 'github', type: 'pr.merged' },
      expiresAt: '2099-01-01T00:00:00Z', createdAt: new Date().toISOString(),
    } as never);
    const first = { id: 'event-1', source: 'github', type: 'pr.merged' };
    const order: string[] = [];
    let secondElapsed = 0;
    const holder = store.tx(async (tx) => {
      expect((await tx.getForUpdate!('subscriptions', sub))?.id).toBe(sub);
      await tx.patch('subscriptions', sub, { event: first } as never);
      order.push('holder-wrote');
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const begin = Date.now();
    const waiter = store.tx(async (tx) => {
      const row = await tx.getForUpdate!('subscriptions', sub);
      secondElapsed = Date.now() - begin;
      order.push('waiter-saw:' + String(row !== null && 'event' in row));
    });
    await Promise.all([holder, waiter]);
    // The waiter must have blocked (not read a stale unlocked row) and then observed the committed first event.
    expect(secondElapsed).toBeGreaterThanOrEqual(150);
    expect(order).toEqual(['holder-wrote', 'waiter-saw:true']);
    await store.delete('subscriptions', sub);
  });
});
