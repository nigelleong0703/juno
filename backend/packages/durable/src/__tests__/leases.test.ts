import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  assertLeaseRow,
  createLeaseGuard,
  createRunner,
  DurableStore,
  fencedDurableDb,
  LeaseLostError,
  object,
  runWithLease,
  workflow,
  type DurableDb,
  type Runner,
  type RunnerOptions,
  type WorkflowContext,
} from '../index.js';
import type { ObjectContext } from '../context.js';
import { backends, closeBackends, eventually } from './backends.js';

afterAll(closeBackends);

const backend = backends[0];
if (backend === undefined) throw new Error('Postgres backend missing');

interface Open { db: DurableDb; close: () => Promise<void> }

const opened: Open[] = [];
const runners: Runner[] = [];

async function open(count = 1): Promise<DurableDb[]> {
  const dbs: DurableDb[] = [];
  for (let i = 0; i < count; i += 1) {
    const next = await backend.open();
    opened.push(next);
    dbs.push(next.db);
  }
  return dbs;
}

function runner(db: DurableDb, opts: Omit<RunnerOptions, 'db'> = {}): Runner {
  const created = createRunner({ db, sweepMs: 20, pollMs: 20, ...opts });
  runners.push(created);
  return created;
}

afterEach(async () => {
  for (const created of runners.splice(0)) created.stop();
  for (const item of opened.splice(0)) await item.close();
});

const rows = (db: DurableDb, sql: string, params: Array<string | number> = []) => db.query<Record<string, unknown>>(sql, params);
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('worker leases on real Postgres', () => {
  it('never steals a healthy invocation, serialises one key and runs distinct keys in parallel', async () => {
    const [db, other] = await open(2);
    const events: string[] = [];
    let gates = 0;
    let open2 = (): void => undefined;
    const both = new Promise<void>((resolve) => { open2 = resolve; });
    let twoStarted = (): void => undefined;
    const live = new Promise<void>((resolve) => { twoStarted = resolve; });
    const svc = object({ name: 'Lane', handlers: {
      async slow(ctx: ObjectContext, name: string): Promise<string> {
        events.push('start ' + name);
        gates += 1;
        if (gates === 2) twoStarted();
        await both;
        events.push('end ' + name);
        return name;
      },
    } });
    const first = runner(db, { maxConcurrent: 2, workerId: 'w1' });
    const second = runner(other, { maxConcurrent: 2, workerId: 'w2' });
    first.register(svc);
    second.register(svc);
    await first.start();
    const a = first.enqueue({ service: 'Lane', key: 'same', handler: 'slow', input: 'a' });
    const b = first.enqueue({ service: 'Lane', key: 'same', handler: 'slow', input: 'b' });
    const c = first.enqueue({ service: 'Lane', key: 'other', handler: 'slow', input: 'c' });
    await live;
    // Two distinct keys are live at once, the second same-key invocation has not started. The order in which two
    // independent keys are claimed is the database's choice.
    expect([...events.filter((event) => event.startsWith('start'))].sort()).toEqual(['start a', 'start c']);
    await second.start();
    await settle(150);
    expect([...events.filter((event) => event.startsWith('start'))].sort()).toEqual(['start a', 'start c']);
    open2();
    await Promise.all([a, b, c]);
    await eventually(() => expect(events.filter((event) => event.startsWith('end'))).toHaveLength(3));
    expect(events.indexOf('start b')).toBeGreaterThan(events.indexOf('end a'));
  });

  it('renews a live lease so a starting worker cannot take it, then hands over on a graceful stop', async () => {
    const [db, other] = await open(2);
    let runs = 0;
    const svc = object({ name: 'Long', handlers: {
      async go(ctx: ObjectContext): Promise<string> { runs += 1; await ctx.sleep(900); return 'ok'; },
    } });
    const first = runner(db, { workerId: 'w1', leaseTtlMs: 300, renewMs: 60 });
    const second = runner(other, { workerId: 'w2', leaseTtlMs: 300, renewMs: 60 });
    first.register(svc);
    second.register(svc);
    await first.start();
    const id = await first.enqueue({ service: 'Long', key: 'k', handler: 'go', input: undefined });
    await eventually(async () => expect((await rows(db, 'SELECT lease_owner FROM invocations WHERE id = ?', [id]))[0]?.['lease_owner']).toBe('w1'));
    // Three lease lifetimes: renewal alone keeps it alive.
    await settle(380);
    await second.start();
    await settle(150);
    expect(runs).toBe(1);
    expect((await rows(db, 'SELECT lease_owner FROM invocations WHERE id = ?', [id]))[0]?.['lease_owner']).toBe('w1');
    // Graceful stop releases the lease; the other worker resumes from the journal without repeating the step.
    first.stop();
    await eventually(async () => expect((await rows(db, 'SELECT status FROM invocations WHERE id = ?', [id]))[0]?.['status']).toBe('done'));
    expect(runs).toBe(2);
  });

  it('keeps claiming while many runs wait on awakeables, so a caller never starves the work it waits for', async () => {
    const [db] = await open();
    const waiting: string[] = [];
    const inner = object({ name: 'Inner', handlers: { async work(): Promise<string> { return 'inner-done'; } } });
    const outer = object({ name: 'Outer', handlers: {
      async viaCall(ctx: ObjectContext): Promise<string> { return ctx.objectClient(inner, 'k').work(undefined); },
      async viaAwakeable(ctx: ObjectContext): Promise<string> {
        const awk = ctx.awakeable<string>();
        await ctx.run('publish', () => { waiting.push(awk.id); });
        return awk.promise;
      },
    } });
    // Six approvals in waiting on a worker bounded to two, then a call that needs a second invocation to run: the waiting runs
    // stop counting once they are parked, so the rest of the approvals and the callee all get claimed.
    const only = runner(db, { workerId: 'w1', maxConcurrent: 2 });
    only.register(inner, outer);
    await only.start();
    for (let n = 0; n < 6; n += 1) await only.enqueue({ service: 'Outer', key: `awk-${String(n)}`, handler: 'viaAwakeable', input: undefined });
    await eventually(() => expect(waiting).toHaveLength(6), 10_000);
    await expect(only.invoke({ service: 'Outer', key: 'call', handler: 'viaCall', input: undefined }, { timeoutMs: 6_000 })).resolves.toBe('inner-done');
    for (const id of waiting) expect(await only.resolveAwakeable(id, 'ok')).toBe(true);
  }, 30_000);

  it('starts a claimed invocation in a clean async context, not in the one of the handler whose enqueue triggered the claim', async () => {
    const [db] = await open();
    const owner = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const child = object({ name: 'CleanChild', handlers: { async go(): Promise<void> { seen.push(owner.getStore()); } } });
    const parent = object({ name: 'CleanParent', handlers: {
      // The handler runs in an owner scope (as every agentd invocation does) and enqueues another invocation from inside it.
      async go(ctx: ObjectContext): Promise<void> { await owner.run('parent-owner', async () => { ctx.objectSendClient(child, 'k').go(undefined); await ctx.run('settle', () => undefined); }); },
    } });
    // No sweep: the only thing that can claim the child is the pass its own enqueue triggers.
    const only = runner(db, { workerId: 'w1', sweepMs: 600_000 });
    only.register(child, parent);
    await only.start();
    await only.enqueue({ service: 'CleanParent', key: 'k', handler: 'go', input: undefined });
    await eventually(() => expect(seen).toHaveLength(1));
    expect(seen).toEqual([undefined]);
  });

  it('shares a burst between workers: one that is using all its slots leaves the rest to the other', async () => {
    const [db, other] = await open(2);
    const hold = new Promise<void>(() => undefined);
    const svc = object({ name: 'Backlog', handlers: { async go(): Promise<void> { await hold; } } });
    const first = runner(db, { workerId: 'w1', maxConcurrent: 5 });
    const second = runner(other, { workerId: 'w2', maxConcurrent: 5 });
    first.register(svc);
    second.register(svc);
    // Twelve due rows exist before either worker starts; both then sweep.
    for (let n = 0; n < 12; n += 1) await new DurableStore(db).insert({ id: `bl-${String(n)}`, service: 'Backlog', key: `k${String(n)}`, handler: 'go', input: null, notBefore: null, idempotencyKey: null, now: Date.now() });
    await Promise.all([first.start(), second.start()]);
    await eventually(async () => {
      const owners = await rows(db, "SELECT lease_owner, count(*) AS n FROM invocations WHERE service = 'Backlog' AND status = 'running' GROUP BY lease_owner");
      expect(owners.map((row) => row['lease_owner']).sort()).toEqual(['w1', 'w2']);
    });
  });

  it('takes over an expired lease and rejects every late write from the old epoch', async () => {
    const [db] = await open();
    const store = new DurableStore(db);
    const { id } = await store.insert({ id: 'takeover-1', service: 'Dead', key: 'k', handler: 'go', input: null, notBefore: null, idempotencyKey: null, now: Date.now() });
    const dead = await store.claim('dead-worker', 250);
    expect(dead?.id).toBe(id);
    const oldFence = dead!.fence;
    let runs = 0;
    const svc = object({ name: 'Dead', handlers: { async go(): Promise<string> { runs += 1; return 'new'; } } });
    const second = runner(db, { workerId: 'w2', leaseTtlMs: 5_000 });
    second.register(svc);
    await second.start();
    await eventually(async () => expect((await rows(db, 'SELECT status, result FROM invocations WHERE id = ?', [id]))[0]?.['result']).toBe('"new"'), 10_000);
    expect(runs).toBe(1);
    // Journal, finish and a business write from the dead worker are all refused by the database fence.
    expect(await store.putJournal(id, 0, 'late', '"x"', null, oldFence)).toBe(false);
    expect(await store.finish({ status: 'done', result: '"stale"', error: null }, { service: 'Dead', key: 'k', json: '{"stale":true}' }, oldFence)).toBe(false);
    await expect(assertLeaseRow(db, oldFence)).rejects.toBeInstanceOf(LeaseLostError);
    const guarded = fencedDurableDb(db);
    await expect(runWithLease(createLeaseGuard(oldFence), () => guarded.query('UPDATE objects SET state = ? WHERE service = ? AND key = ?', ['{"stale":true}', 'Dead', 'k']))).rejects.toBeInstanceOf(LeaseLostError);
    expect(await rows(db, 'SELECT state FROM objects WHERE service = ? AND key = ?', ['Dead', 'k'])).toHaveLength(0);
  });

  it('fences raw SQL by transaction, including WITH and comment-prefixed statements (no prefix parsing)', async () => {
    const [db] = await open();
    const store = new DurableStore(db);
    await store.insert({ id: 'raw-1', service: 'Raw', key: 'k', handler: 'go', input: null, notBefore: null, idempotencyKey: null, now: Date.now() });
    const claimed = await store.claim('w1', 5_000);
    expect(claimed?.id).toBe('raw-1');
    const fence = claimed!.fence;
    const guarded = fencedDurableDb(db);
    const guard = createLeaseGuard(fence);
    await runWithLease(guard, async () => {
      await guarded.query('INSERT INTO objects (service, key, state) VALUES (?, ?, ?) ON CONFLICT (service, key) DO UPDATE SET state = excluded.state', ['Raw', 'k', '{"v":1}']);
      // A data-modifying CTE and a comment-prefixed statement are fenced like any other statement.
      await guarded.query('WITH next AS (SELECT ?::text AS s) UPDATE objects SET state = next.s FROM next WHERE service = ? AND key = ?', ['{"v":2}', 'Raw', 'k']);
      await guarded.query('/* leading comment */ UPDATE objects SET state = ? WHERE service = ? AND key = ?', ['{"v":3}', 'Raw', 'k']);
    });
    expect((await rows(db, 'SELECT state FROM objects WHERE service = ? AND key = ?', ['Raw', 'k']))[0]?.['state']).toBe('{"v":3}');
    // The worker loses the lease; the same statements now fail and change nothing.
    await db.query("UPDATE invocations SET lease_owner = 'other' WHERE id = 'raw-1'");
    await expect(runWithLease(guard, () => guarded.query('/* comment */ UPDATE objects SET state = ? WHERE service = ? AND key = ?', ['{"stale":true}', 'Raw', 'k']))).rejects.toBeInstanceOf(LeaseLostError);
    await expect(runWithLease(guard, () => guarded.query('WITH s AS (SELECT ?::text AS v) UPDATE objects SET state = s.v FROM s WHERE service = ? AND key = ?', ['{"stale":true}', 'Raw', 'k']))).rejects.toBeInstanceOf(LeaseLostError);
    expect((await rows(db, 'SELECT state FROM objects WHERE service = ? AND key = ?', ['Raw', 'k']))[0]?.['state']).toBe('{"v":3}');
  });

  it('refuses an old invocation after another invocation took the same key lane, and rolls a partial renewal back', async () => {
    const [db] = await open();
    const store = new DurableStore(db);
    await store.insert({ id: 'lane-a', service: 'LaneKey', key: 'k', handler: 'go', input: null, notBefore: null, idempotencyKey: null, now: Date.now() });
    const a = await store.claim('w1', 5_000);
    expect(a?.id).toBe('lane-a');
    await store.insert({ id: 'lane-b', service: 'LaneKey', key: 'k', handler: 'go', input: null, notBefore: null, idempotencyKey: null, now: Date.now() + 1 });
    // Only the lane's lease dies (a lane renewal failure); the invocation lease is still valid.
    await db.query("UPDATE invocation_lanes SET expires_at = 1 WHERE service = 'LaneKey' AND key = 'k'");
    const before = Number((await rows(db, 'SELECT lease_expires_at FROM invocations WHERE id = ?', ['lane-a']))[0]?.['lease_expires_at']);
    expect(await store.renew([a!.fence], 60_000)).toEqual(['lane-a']);
    expect(Number((await rows(db, 'SELECT lease_expires_at FROM invocations WHERE id = ?', ['lane-a']))[0]?.['lease_expires_at'])).toBe(before);
    const b = await store.claim('w2', 5_000);
    expect(b?.id).toBe('lane-b');
    expect(b!.fence.laneEpoch).not.toBe(a!.fence.laneEpoch);
    // The old invocation no longer holds the key: journal, finish and business writes are refused.
    expect(await store.putJournal('lane-a', 0, 'late', '"x"', null, a!.fence)).toBe(false);
    expect(await store.finish({ status: 'done', result: '"old"', error: null }, undefined, a!.fence)).toBe(false);
    const guarded = fencedDurableDb(db);
    await expect(runWithLease(createLeaseGuard(a!.fence), () => guarded.query('WITH s AS (SELECT ?::text AS v) UPDATE objects SET state = s.v FROM s WHERE service = ? AND key = ?', ['{"old":true}', 'LaneKey', 'k']))).rejects.toBeInstanceOf(LeaseLostError);
    expect(await rows(db, 'SELECT state FROM objects WHERE service = ? AND key = ?', ['LaneKey', 'k'])).toHaveLength(0);
    // The new owner's fence still writes normally.
    await runWithLease(createLeaseGuard(b!.fence), () => guarded.query('WITH s AS (SELECT ?::text AS v) INSERT INTO objects (service, key, state) SELECT ?, ?, s.v FROM s ON CONFLICT (service, key) DO UPDATE SET state = excluded.state', ['{"new":true}', 'LaneKey', 'k']));
    expect((await rows(db, 'SELECT state FROM objects WHERE service = ? AND key = ?', ['LaneKey', 'k']))[0]?.['state']).toBe('{"new":true}');
  });

  it('does not deadlock fenced writes against the renewal and the finish of the same lease (one lock order)', async () => {
    const [db, other] = await open(2);
    const store = new DurableStore(db);
    const second = new DurableStore(other);
    const guarded = fencedDurableDb(db);
    const failures: string[] = [];
    for (let round = 0; round < 40; round += 1) {
      const id = `dl-${String(round)}`;
      await store.insert({ id, service: 'Deadlock', key: id, handler: 'go', input: null, notBefore: null, idempotencyKey: null, now: Date.now() });
      const claimed = await store.claim('w1', 5_000);
      expect(claimed?.id).toBe(id);
      const fence = claimed!.fence;
      const writes = Array.from({ length: 4 }, () => runWithLease(createLeaseGuard(fence), () => guarded.transaction(async (tx) => {
        await tx.query('INSERT INTO objects (service, key, state) VALUES (?, ?, ?) ON CONFLICT (service, key) DO UPDATE SET state = excluded.state', ['Deadlock', id, '{}']);
      })));
      const settled = await Promise.allSettled([...writes, second.renew([fence], 5_000), second.finish({ status: 'done', result: null, error: null }, undefined, fence)]);
      for (const outcome of settled) {
        // A write that lost the race to the finish is refused with LeaseLostError; a database deadlock is the failure.
        if (outcome.status === 'rejected' && !(outcome.reason instanceof LeaseLostError)) failures.push(String(outcome.reason));
      }
    }
    expect(failures).toEqual([]);
  });

  it('serialises a takeover against a write that already proved the fence but has not committed', async () => {
    const [db] = await open(2);
    const store = new DurableStore(db);
    await store.insert({ id: 'race-a', service: 'Race', key: 'k', handler: 'go', input: null, notBefore: null, idempotencyKey: null, now: Date.now() });
    const a = await store.claim('w1', 300);
    expect(a?.id).toBe('race-a');
    await store.insert({ id: 'race-b', service: 'Race', key: 'k', handler: 'go', input: null, notBefore: null, idempotencyKey: null, now: Date.now() + 1 });
    let releaseWrite = (): void => undefined;
    const hold = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let checked = (): void => undefined;
    const checkedNow = new Promise<void>((resolve) => { checked = resolve; });
    const lateWrite = db.transaction(async (tx) => {
      await assertLeaseRow(tx, a!.fence);
      checked();
      await hold;
      await tx.query('UPDATE objects SET state = ? WHERE service = ? AND key = ?', ['{"a":true}', 'Race', 'k']);
      await tx.query('INSERT INTO objects (service, key, state) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM objects WHERE service = ? AND key = ?)', ['Race', 'k', '{"a":true}', 'Race', 'k']);
    });
    await checkedNow;
    // The lease expires while the write holds its fence; the other connection's takeover must wait for the commit.
    await settle(350);
    const takeover = store.claim('w2', 5_000);
    await settle(200);
    const pending = await Promise.race([takeover.then(() => 'claimed'), settle(150).then(() => 'waiting')]);
    expect(pending).toBe('waiting');
    releaseWrite();
    await lateWrite;
    const b = await takeover;
    expect(b?.id).toBe('race-b');
    expect((await rows(db, 'SELECT state FROM objects WHERE service = ? AND key = ?', ['Race', 'k']))[0]?.['state']).toBe('{"a":true}');
    // Once the new invocation owns the key, the old fence can no longer write at all.
    await expect(assertLeaseRow(db, a!.fence)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('wakes a run on one worker from an awakeable, a call result and a cancel resolved on another', async () => {
    const [db, other] = await open(2);
    let awakeId = '';
    const waits = object({ name: 'Wait', handlers: {
      async go(ctx: ObjectContext): Promise<unknown> { const a = ctx.awakeable<string>(); awakeId = a.id; return a.promise; },
      async call(ctx: ObjectContext, n: number): Promise<number> {
        const calc = object({ name: 'Calc', handlers: { async echo(_c: ObjectContext, v: number): Promise<number> { return v * 2; } } });
        return ctx.objectClient<typeof calc>(calc, 'n').echo(n);
      },
    } });
    const flow = workflow({ name: 'StopFlow', handlers: {
      async run(ctx: WorkflowContext): Promise<string> { await ctx.promise<boolean>('cancel').get(); return 'stopped'; },
      async cancel(ctx: WorkflowContext): Promise<void> { await ctx.promise<boolean>('cancel').resolve(true); },
    } });
    const calc = object({ name: 'Calc', handlers: { async echo(_c: ObjectContext, v: number): Promise<number> { return v * 2; } } });
    const first = runner(db, { workerId: 'w1', maxConcurrent: 1 });
    const second = runner(other, { workerId: 'w2', maxConcurrent: 2 });
    first.register(waits, calc, flow);
    second.register(waits, calc, flow);
    await first.start();
    await second.start();
    const waiting = first.invoke({ service: 'Wait', key: 'wake', handler: 'go', input: undefined }).catch(() => undefined);
    await eventually(() => expect(awakeId).not.toBe(''));
    await settle(100);
    expect(await second.resolveAwakeable(awakeId, 'tap')).toBe(true);
    expect(await waiting).toBe('tap');
    // A call to another service finishes on the other worker and its result reaches the caller.
    expect(await first.invoke({ service: 'Wait', key: 'caller', handler: 'call', input: 21 })).toBe(42);
    // A cancel sent on one worker stops a run waiting on another.
    const stopping = first.invoke({ service: 'StopFlow', key: 'cancelled', handler: 'run', input: undefined });
    await settle(100);
    await second.sendTo({ service: 'StopFlow', key: 'cancelled', handler: 'cancel', input: undefined });
    expect(await stopping).toBe('stopped');
  });

  it('keeps a delayed invocation across a restart and runs it once', async () => {
    const [db, other] = await open(2);
    let runs = 0;
    const svc = object({ name: 'Timer', handlers: { async fire(): Promise<number> { runs += 1; return runs; } } });
    const first = runner(db, { workerId: 'w1' });
    first.register(svc);
    await first.start();
    await first.sendTo({ service: 'Timer', key: 't', handler: 'fire', input: undefined }, { delayMs: 400 });
    await settle(100);
    first.stop();
    const began = Date.now();
    const second = runner(other, { workerId: 'w2' });
    second.register(svc);
    await second.start();
    await eventually(() => expect(runs).toBe(1), 5_000);
    expect(Date.now() - began).toBeGreaterThanOrEqual(200);
    await settle(400);
    expect(runs).toBe(1);
  });

  it('leaves lease-less legacy rows alone until the lock-holding coordinator hands them over', async () => {
    const [db] = await open();
    const store = new DurableStore(db);
    await db.query("INSERT INTO invocations (id, service, key, handler, status, created_at, updated_at) VALUES ('legacy-1', 'Old', 'k', 'go', 'running', 1, 1)");
    expect(await store.claim('w1', 5_000)).toBeUndefined();
    expect((await rows(db, "SELECT status FROM invocations WHERE id = 'legacy-1'"))[0]?.['status']).toBe('running');
    expect(await store.reclaimLegacy()).toBe(1);
    expect((await rows(db, "SELECT status FROM invocations WHERE id = 'legacy-1'"))[0]?.['status']).toBe('pending');
  });

  it('gates workers on the coordinator capability marker and closes when it drains', async () => {
    const [db] = await open();
    const store = new DurableStore(db);
    expect(await store.coordinationReady('worker-leases', 60_000)).toBe(false);
    await store.activateCoordination('worker-leases');
    expect(await store.coordinationReady('worker-leases', 60_000)).toBe(true);
    expect(await store.heartbeatCoordination('worker-leases')).toBe(true);
    await store.drainCoordination('worker-leases');
    expect(await store.coordinationReady('worker-leases', 60_000)).toBe(false);
  });
});
