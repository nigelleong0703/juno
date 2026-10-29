/**
 * Idle workers listen instead of polling (BACKEND 2.2c): new work, a freed lane, a delayed start and a dead worker's expired lease each
 * wake a worker without a steady sweep, and an idle worker sends almost no claim queries. Real Postgres, one connection per "process".
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createRunner, DurableStore, object, type DurableDb, type Runner, type RunnerOptions } from '../index.js';
import type { ObjectContext } from '../context.js';
import { backends, closeBackends, eventually } from './backends.js';

afterAll(closeBackends);

const backend = backends[0];
if (backend === undefined) throw new Error('Postgres backend missing');

const opened: Array<{ close: () => Promise<void> }> = [];
const runners: Runner[] = [];

/** A handle that counts the statements a process sends (claim passes, and everything). */
async function open(): Promise<{ db: DurableDb; claims: () => number; statements: () => number }> {
  const next = await backend!.open();
  opened.push(next);
  let claims = 0;
  let statements = 0;
  const count = (sql: string): void => { statements += 1; if (sql.includes('SKIP LOCKED')) claims += 1; };
  const wrap = (inner: DurableDb): DurableDb => {
    const counted: DurableDb = {
      query: (sql, params) => { count(sql); return inner.query(sql, params); },
      transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
    };
    if (inner.listen !== undefined) counted.listen = inner.listen.bind(inner);
    return counted;
  };
  return { db: wrap(next.db), claims: () => claims, statements: () => statements };
}

function runner(db: DurableDb, opts: Omit<RunnerOptions, 'db'> = {}): Runner {
  const created = createRunner({ db, pollMs: 20, ...opts });
  runners.push(created);
  return created;
}

afterEach(async () => {
  for (const created of runners.splice(0)) created.stop();
  for (const item of opened.splice(0)) await item.close();
});

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const started = new Map<string, number>();
const svc = object({ name: 'Wake', handlers: {
  async go(_ctx: ObjectContext, name: string): Promise<string> { started.set(name, Date.now()); return name; },
} });

describe('waking workers with LISTEN / NOTIFY', () => {
  it('sends an idle worker almost no claim queries, where a polling worker sends one a second', async () => {
    const idle = await open();
    const polling = await open();
    const listener = runner(idle.db);
    listener.register(svc);
    await listener.start();
    const poller = runner(polling.db, { sweepMs: 1_000 });
    poller.register(svc);
    await poller.start();
    const before = { idle: idle.claims(), polling: polling.claims() };
    await settle(3_500);
    const idleClaims = idle.claims() - before.idle;
    const pollingClaims = polling.claims() - before.polling;
    // Rows to wait for: none, so the listening worker has nothing to look at before its 30s safety sweep.
    expect(idleClaims).toBe(0);
    expect(pollingClaims).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it('hands new work from the coordinator to an idle worker within 200 ms', async () => {
    const coordinatorHandle = await open();
    const workerHandle = await open();
    const coordinator = runner(coordinatorHandle.db, { execute: false });
    coordinator.register(svc);
    const worker = runner(workerHandle.db);
    worker.register(svc);
    await worker.start();
    await settle(300);
    const latencies: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const name = 'new-' + String(round);
      const at = Date.now();
      await coordinator.enqueue({ service: 'Wake', key: name, handler: 'go', input: name });
      await eventually(() => { expect(started.has(name)).toBe(true); });
      latencies.push((started.get(name) ?? 0) - at);
      await settle(100);
    }
    expect(Math.max(...latencies), 'slowest of five: ' + latencies.join(', ')).toBeLessThan(200);
  }, 15_000);

  it('starts a delayed invocation at its time with no polling, and takes over a dead worker\'s lease when it expires', async () => {
    const handle = await open();
    const worker = runner(handle.db, { leaseTtlMs: 600 });
    worker.register(svc);
    await worker.start();
    const queuedAt = Date.now();
    await worker.enqueue({ service: 'Wake', key: 'later', handler: 'go', input: 'later' }, { delayMs: 700 });
    await eventually(() => { expect(started.has('later')).toBe(true); });
    const lateBy = (started.get('later') ?? 0) - (queuedAt + 700);
    expect(lateBy).toBeGreaterThanOrEqual(-30);
    expect(lateBy).toBeLessThan(600);

    // A worker that claimed and died: nothing announces its lease running out, the next-due timer does.
    worker.stop();
    // Opening a handle empties the runner's tables, so every handle is opened before the dead worker's row is written.
    const survivorHandle = await open();
    const other = await open();
    const store = new DurableStore(other.db);
    const dead = await store.insert({ id: 'dead-1', service: 'Wake', key: 'dead', handler: 'go', input: JSON.stringify('dead'), notBefore: null, idempotencyKey: null, now: Date.now() });
    expect((await store.claim('dead-worker', 500))?.id).toBe(dead.id);
    const survivor = runner(survivorHandle.db, { leaseTtlMs: 600 });
    survivor.register(svc);
    await survivor.start();
    const at = Date.now();
    await eventually(() => { expect(started.has('dead')).toBe(true); });
    expect((started.get('dead') ?? 0) - at).toBeLessThan(1_500);
  }, 15_000);

  it('wakes a worker when a finishing run frees the lane a pending invocation of the same key waits behind', async () => {
    const first = await open();
    const second = await open();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lane = object({ name: 'Lane2', handlers: {
      async hold(_ctx: ObjectContext): Promise<string> { await gate; return 'held'; },
      async next(_ctx: ObjectContext): Promise<string> { started.set('lane-next', Date.now()); return 'next'; },
    } });
    const a = runner(first.db);
    a.register(lane);
    await a.start();
    const b = runner(second.db);
    b.register(lane);
    await b.start();
    await a.enqueue({ service: 'Lane2', key: 'same', handler: 'hold' });
    await settle(300);
    await a.enqueue({ service: 'Lane2', key: 'same', handler: 'next' });
    await settle(300);
    expect(started.has('lane-next')).toBe(false);
    const freedAt = Date.now();
    release();
    await eventually(() => { expect(started.has('lane-next')).toBe(true); });
    expect((started.get('lane-next') ?? 0) - freedAt).toBeLessThan(400);
  }, 15_000);
});
