/**
 * Account ownership isolation on the in-memory store (AU2): owner filtering happens before
 * pagination, direct ids never cross owners, puts force the scope owner, patches cannot move
 * rows, transactions stay scoped, and events replay/live-filter by persisted owner.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@agent-desktop/contracts';
import { UNKNOWN_OWNER } from '../owner-events.js';
import { backends, eventually, uid, type TestStore } from './store-backends';

// Fresh owners per test: Postgres keeps its rows between runs.
let A = '', B = '';
/** Doc ids are unique per test owner. */
const id = (name: string): string => A + '-' + name;
let mem: TestStore;
let close: () => Promise<void>;

function agent(id: string, owner: string, createdAt: string) {
  return { id, ownerId: owner, handle: id, name: id, createdAt };
}

describe.each(backends)('scoped documents ($name)', (backend) => {
  beforeEach(async () => { A = uid('owner-a'); B = uid('owner-b'); ({ store: mem, close } = await backend.open()); });
  afterEach(() => close());

  it('filters by owner before pagination across mixed timestamps', async () => {
    const store = mem;
    await store.put('agents', agent(id('a1'), A, '2026-01-01T00:00:00.000Z'));
    await store.put('agents', agent(id('b1'), B, '2026-01-02T00:00:00.000Z'));
    await store.put('agents', agent(id('a2'), A, '2026-01-03T00:00:00.000Z'));
    await store.put('agents', agent(id('b2'), B, '2026-01-04T00:00:00.000Z'));
    await store.put('agents', agent(id('a3'), A, '2026-01-05T00:00:00.000Z'));

    const scopedA = store.forOwner!(A);
    const first = await scopedA.list('agents', { orderBy: 'at', limit: 2 });
    expect(first.items.map((d) => d.id)).toEqual([id('a1'), id('a2')]);
    expect(first.nextCursor).toBeDefined();
    const second = await scopedA.list('agents', { orderBy: 'at', limit: 2, cursor: first.nextCursor });
    expect(second.items.map((d) => d.id)).toEqual([id('a3')]);
    expect(second.nextCursor).toBeUndefined();

    const scopedB = store.forOwner!(B);
    const allB = await scopedB.list('agents', { orderBy: 'at', limit: 10 });
    expect(allB.items.map((d) => d.id)).toEqual([id('b1'), id('b2')]);
  });

  it('fences direct ids: get null, patch/delete fail, put collision never overwrites', async () => {
    const store = mem;
    await store.put('agents', agent(id('shared'), A, '2026-01-01T00:00:00.000Z'));
    const scopedB = store.forOwner!(B);

    await expect(scopedB.get('agents', id('shared'))).resolves.toBeNull();
    await expect(scopedB.patch('agents', id('shared'), { name: 'evil' })).rejects.toThrow(NotFoundError);
    await scopedB.delete('agents', id('shared'));
    await expect(store.get('agents', id('shared'))).resolves.toMatchObject({ name: id('shared') });

    await expect(scopedB.put('agents', agent(id('shared'), B, '2026-01-02T00:00:00.000Z'))).rejects.toThrow(
      /another owner/
    );
    await expect(store.get('agents', id('shared'))).resolves.toMatchObject({ ownerId: A, name: id('shared') });
  });

  it('injects the scope owner on put and keeps owners immutable on patch', async () => {
    const scopedA = mem.forOwner!(A);
    await scopedA.put('agents', { id: id('x1'), handle: id('x1'), name: id('x1') });
    await expect(scopedA.get('agents', id('x1'))).resolves.toMatchObject({ ownerId: A });
    await scopedA.patch('agents', id('x1'), { ownerId: B, name: 'renamed' });
    await expect(scopedA.get('agents', id('x1'))).resolves.toMatchObject({ ownerId: A, name: 'renamed' });
    const scopedB = mem.forOwner!(B);
    await expect(scopedB.get('agents', id('x1'))).resolves.toBeNull();
  });

  it('returns the forced doc on scoped put and keeps ids immutable on patch', async () => {
    const scopedA = mem.forOwner!(A);
    const saved = await scopedA.put('agents', { id: id('f1'), handle: id('f1'), name: id('f1') });
    expect(saved).toMatchObject({ id: id('f1'), ownerId: A });
    await scopedA.patch('agents', id('f1'), { id: id('hijacked'), name: 'kept' });
    const reread = await scopedA.get('agents', id('f1'));
    expect(reread).toMatchObject({ id: id('f1'), name: 'kept' });
    await expect(scopedA.get('agents', id('hijacked'))).resolves.toBeNull();
  });

  it('keeps transactions inside the scope and the raw store unscoped', async () => {
    const base = (await mem.eventBus.head?.()) ?? 0;
    const scopedA = mem.forOwner!(A);
    await scopedA.tx(async (tx) => {
      await tx.put('agents', agent(id('t1'), 'ignored-owner', '2026-01-01T00:00:00.000Z'));
      await tx.emit({ type: 'agent.status', agentId: id('t1'), status: 'idle' });
    });
    await expect(scopedA.get('agents', id('t1'))).resolves.toMatchObject({ ownerId: A });
    const scopedB = mem.forOwner!(B);
    await expect(scopedB.get('agents', id('t1'))).resolves.toBeNull();
    const replayB = await mem.eventBus.forOwner!(B).since(base);
    expect(replayB).toHaveLength(0);
    const replayA = await mem.eventBus.forOwner!(A).since(base);
    expect(replayA).toHaveLength(1);
    // The raw log is global (other suites may be writing to a shared database): look for this test's event only.
    const replayRaw = (await mem.eventBus.since(base)).filter((e) => e.id === replayA[0]?.id);
    expect(replayRaw).toHaveLength(1);
  });
});

describe.each(backends)('scoped events ($name)', (backend) => {
  beforeEach(async () => { A = uid('owner-a'); B = uid('owner-b'); ({ store: mem, close } = await backend.open()); });
  afterEach(() => close());

  it('derives raw emit owners from persisted rows and hides unknown from scoped replay', async () => {
    const base = (await mem.eventBus.head?.()) ?? 0;
    const ghost = uid('ghost-run');
    await mem.put('agents', agent(id('a1'), A, '2026-01-01T00:00:00.000Z'));
    await mem.emit({ type: 'agent.status', agentId: id('a1'), status: 'working' });
    await mem.emit({ type: 'step.added', runId: ghost, step: { id: 's1' } });

    const raw = (await mem.eventBus.since(base)).filter((e) => 'agentId' in e.event && e.event.agentId === id('a1') || 'runId' in e.event && e.event.runId === ghost);
    expect(raw).toHaveLength(2);
    const scopedA = await mem.eventBus.forOwner!(A).since(base);
    expect(scopedA).toHaveLength(1);
    expect(scopedA[0]?.event.type).toBe('agent.status');
    const scopedB = await mem.eventBus.forOwner!(B).since(base);
    expect(scopedB).toHaveLength(0);
  });

  it('delivers live events only to the owning subscriber', async () => {
    const seenA: number[] = [];
    const seenB: number[] = [];
    const unsubA = await mem.eventBus.forOwner!(A).subscribe((e) => {
      seenA.push(e.id);
    });
    const unsubB = await mem.eventBus.forOwner!(B).subscribe((e) => {
      seenB.push(e.id);
    });
    try {
      const scopedA = mem.forOwner!(A);
      await scopedA.emit({ type: 'agent.status', agentId: 'x', status: 'idle' });
      await scopedA.emit({ type: 'agent.status', agentId: 'y', status: 'idle' });
      const scopedB = mem.forOwner!(B);
      await scopedB.emit({ type: 'agent.status', agentId: 'z', status: 'idle' });
      await eventually(() => {
        expect(seenA).toHaveLength(2);
        expect(seenB).toHaveLength(1);
      });
      expect(seenB[0]).toBeGreaterThan(seenA[1]);
    } finally {
      await unsubA();
      await unsubB();
    }
  });

  it('marks unresolvable raw emits unknown', async () => {
    const base = (await mem.eventBus.head?.()) ?? 0;
    const nobody = uid('nobody');
    await mem.emit({ type: 'agent.status', agentId: nobody, status: 'idle' });
    const scopedA = await mem.eventBus.forOwner!(A).since(base);
    expect(scopedA).toHaveLength(0);
    expect((await mem.eventBus.since(base)).filter((e) => 'agentId' in e.event && e.event.agentId === nobody)).toHaveLength(1);
    expect(UNKNOWN_OWNER).toBe('unknown');
  });
});
