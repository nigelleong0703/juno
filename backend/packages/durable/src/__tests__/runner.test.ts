import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handlers, object, rpc, TerminalError, workflow, type ObjectContext, type VirtualObjectDefinition, type WorkflowContext, type WorkflowDefinition } from '../index.js';
import { createRunner, type Runner } from '../runner.js';
import type { DurableDb } from '../db.js';
import { backends, closeBackends, eventually } from './backends.js';

afterAll(closeBackends);

describe.each(backends)('durable runner ($name)', (backend) => {
  let db: DurableDb;
  let close: () => Promise<void>;
  const runners: Runner[] = [];
  const make = (opts: { maxAttempts?: number } = {}): Runner => {
    const runner = createRunner({ db, backoffMs: () => 1, sweepMs: 50, ...opts });
    runners.push(runner);
    return runner;
  };
  beforeEach(async () => { ({ db, close } = await backend.open()); });
  afterEach(async () => { for (const r of runners.splice(0)) r.stop(); await close(); });

  const rows = (sql: string, params: Array<string | number> = []) => db.query(sql, params);

  it('replays saved steps after a failed attempt and clears the journal when done', async () => {
    const calls = { first: 0, second: 0 };
    let failed = false;
    const svc = object({ name: 'Steps', handlers: {
      async go(ctx: ObjectContext): Promise<string> {
        const a = await ctx.run('first', async () => { calls.first += 1; return 'a'; });
        const b = await ctx.run('second', async () => { calls.second += 1; if (!failed) { failed = true; throw new Error('boom'); } return 'b'; });
        return a + b;
      },
    } });
    const runner = make();
    runner.register(svc);
    await runner.start();
    expect(await runner.invoke({ service: 'Steps', key: 'k', handler: 'go', input: undefined })).toBe('ab');
    expect(calls).toEqual({ first: 1, second: 2 });
    expect(await rows('SELECT * FROM journal')).toHaveLength(0);
  });

  it('claims work enqueued while a claim pass is running without waiting for the sweep', async () => {
    const done: string[] = [];
    const svc = object({ name: 'Burst', handlers: { async go(ctx: ObjectContext): Promise<void> { done.push(ctx.key); } } });
    // Each claim select holds its transaction a little after it read, so an enqueue lands while a pass that saw nothing is
    // still running. The sweep is far beyond the test: only the pass the enqueue asks for can pick the second row up.
    const slow = (inner: DurableDb): DurableDb => ({
      query: (sql, params) => inner.query(sql, params),
      transaction: (fn) => inner.transaction((tx) => fn({
        query: async (sql, params) => {
          const out = await tx.query(sql, params);
          if (sql.includes('SKIP LOCKED')) await new Promise((resolve) => setTimeout(resolve, 300));
          return out as never;
        },
        transaction: (inner2) => tx.transaction(inner2),
      })),
    });
    const runner = createRunner({ db: slow(db), backoffMs: () => 1, sweepMs: 600_000 });
    runners.push(runner);
    runner.register(svc);
    await runner.start();
    await runner.enqueue({ service: 'Burst', key: 'first', handler: 'go', input: undefined });
    // The pass that claimed `first` is now in its second, empty select.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await runner.enqueue({ service: 'Burst', key: 'second', handler: 'go', input: undefined });
    await eventually(() => expect(done).toEqual(['first', 'second']), 3_000);
  });

  it('ends an invocation whose saved step no longer matches the code, with a readable reason', async () => {
    const svc = object({ name: 'Mismatch', handlers: { async go(ctx: ObjectContext): Promise<string> { return ctx.run('new-name', async () => 'x'); } } });
    const id = 'inv-mismatch';
    // A crashed worker's row: its lease (and the one its key held) expired, so a new worker may take it.
    await db.query("INSERT INTO invocations (id, service, key, handler, status, lease_owner, epoch, lease_expires_at, created_at, updated_at) VALUES (?, 'Mismatch', 'k', 'go', 'running', 'gone', 1, 1, 1, 1)", [id]);
    await db.query('INSERT INTO journal (invocation_id, seq, name, result) VALUES (?, 0, ?, ?)', [id, 'old-name', '"x"']);
    const second = make();
    second.register(svc);
    await second.start();
    await eventually(async () => {
      const [row] = await rows('SELECT status, error FROM invocations WHERE id = ?', [id]);
      expect(row?.['status']).toBe('failed');
      expect(String(row?.['error'])).toContain('old-name');
    });
  });

  it('sleeps only the remainder after a restart', async () => {
    let started = 0;
    const svc = object({ name: 'Sleeper', handlers: { async go(ctx: ObjectContext): Promise<number> { started += 1; await ctx.sleep(400); return started; } } });
    const first = make();
    first.register(svc);
    await first.start();
    const id = await first.enqueue({ service: 'Sleeper', key: 'k', handler: 'go', input: undefined });
    await eventually(async () => expect(await rows('SELECT * FROM journal WHERE invocation_id = ?', [id])).toHaveLength(1));
    first.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = make();
    second.register(svc);
    const began = Date.now();
    await second.start();
    await eventually(async () => expect((await rows('SELECT status FROM invocations WHERE id = ?', [id]))[0]?.['status']).toBe('done'));
    expect(Date.now() - began).toBeLessThan(350);
    expect(started).toBe(2);
  });

  it('forgets everything under the given keys and prefixes (account deletion), and only those', async () => {
    const svc = object({ name: 'Forgettable', handlers: { async go(ctx: ObjectContext, n: number): Promise<number> { ctx.set('n', n); return n; } } });
    const runner = make();
    runner.register(svc);
    await runner.start();
    for (const key of ['agt-1:conv-a', 'agt-1:conv-a::child:x', 'agt-10:conv-b', 'run-1', 'run-2', 'owner-1']) {
      await runner.invoke({ service: 'Forgettable', key, handler: 'go', input: 1 });
    }
    // A pending (delayed) invocation of a forgotten key goes too; the prefix `agt-1:` must not catch `agt-10:` (the colon is part of it).
    await runner.sendTo({ service: 'Forgettable', key: 'run-1', handler: 'go', input: 2 }, { delayMs: 60_000 });
    const removed = await runner.forget({ exact: ['run-1', 'owner-1'], prefixes: ['agt-1:'] });
    expect(removed).toBe(5);
    expect((await rows('SELECT DISTINCT key FROM invocations ORDER BY key')).map((row) => row['key'])).toEqual(['agt-10:conv-b', 'run-2']);
    expect((await rows('SELECT key FROM objects ORDER BY key')).map((row) => row['key'])).toEqual(['agt-10:conv-b', 'run-2']);
    expect(await runner.forget({ exact: ['run-1'], prefixes: ['agt-1:'] })).toBe(0);
  });

  it('lets the first resolver of an awakeable win, also across a restart', async () => {
    let awakeId = '';
    const svc = object({ name: 'Wait', handlers: {
      async go(ctx: ObjectContext): Promise<unknown> {
        const a = ctx.awakeable<string>();
        awakeId = a.id;
        return a.promise;
      },
    } });
    const first = make();
    first.register(svc);
    await first.start();
    const pending = first.invoke({ service: 'Wait', key: 'k', handler: 'go', input: undefined }).catch(() => undefined);
    await eventually(() => expect(awakeId).not.toBe(''));
    await eventually(async () => expect(await rows('SELECT id FROM waits')).toHaveLength(1));
    first.stop();
    void pending;
    const second = make();
    second.register(svc);
    await second.start();
    expect(await second.resolveAwakeable(awakeId, 'tap')).toBe(true);
    expect(await second.resolveAwakeable(awakeId, 'message')).toBe(false);
    await eventually(async () => {
      const [row] = await rows('SELECT status, result FROM invocations');
      expect(row?.['status']).toBe('done');
      expect(row?.['result']).toBe('"tap"');
    });
  });

  it('runs one invocation per idempotency key and returns the first result', async () => {
    let runs = 0;
    const svc = object({ name: 'Once', handlers: { async go(_ctx: ObjectContext, n: number): Promise<number> { runs += 1; return n; } } });
    const runner = make();
    runner.register(svc);
    await runner.start();
    const a = await runner.invoke({ service: 'Once', key: 'k', handler: 'go', input: 1 }, { idempotencyKey: 'same' });
    const b = await runner.invoke({ service: 'Once', key: 'k', handler: 'go', input: 2 }, { idempotencyKey: 'same' });
    expect([a, b, runs]).toEqual([1, 1, 1]);
  });

  it('runs a workflow once per key', async () => {
    let runs = 0;
    const svc = workflow({ name: 'Flow', handlers: { async run(_ctx: WorkflowContext): Promise<void> { runs += 1; } } });
    const runner = make();
    runner.register(svc);
    await runner.start();
    await runner.invoke({ service: 'Flow', key: 'r1', handler: 'run', input: undefined });
    await runner.invoke({ service: 'Flow', key: 'r1', handler: 'run', input: undefined });
    expect(runs).toBe(1);
  });

  it('serialises exclusive handlers per key, lets other keys and shared handlers pass', async () => {
    const log: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const svc = object({ name: 'Lane', handlers: {
      async slow(_ctx: ObjectContext, name: string): Promise<void> { log.push('start ' + name); await gate; log.push('end ' + name); },
      peek: handlers.object.shared(async (): Promise<string> => 'peeked'),
    } });
    const runner = make();
    runner.register(svc);
    await runner.start();
    const a = runner.invoke({ service: 'Lane', key: 'same', handler: 'slow', input: 'a' });
    const b = runner.invoke({ service: 'Lane', key: 'same', handler: 'slow', input: 'b' });
    const other = runner.enqueue({ service: 'Lane', key: 'other', handler: 'slow', input: 'c' });
    await eventually(() => expect(log).toContain('start c'));
    expect(await runner.invoke({ service: 'Lane', key: 'same', handler: 'peek', input: undefined })).toBe('peeked');
    // Two distinct keys run at once; which claim lands first is the database's choice.
    expect([...log].sort()).toEqual(['start a', 'start c']);
    release();
    await Promise.all([a, b, other]);
    await eventually(() => expect(log.filter((l) => l.startsWith('end'))).toHaveLength(3));
    expect(log.indexOf('start b')).toBeGreaterThan(log.indexOf('end a'));
  });

  it('retries a failing invocation up to the cap, then fails it terminally and tells onFailure', async () => {
    let tries = 0;
    const failures: string[] = [];
    const svc = object({ name: 'Flaky', handlers: { async go(): Promise<void> { tries += 1; throw new Error('always'); } }, onFailure: async (info) => { failures.push(info.key + ':' + info.message); } });
    const runner = make({ maxAttempts: 3 });
    runner.register(svc);
    await runner.start();
    await expect(runner.invoke({ service: 'Flaky', key: 'k', handler: 'go', input: undefined })).rejects.toThrow(TerminalError);
    expect(tries).toBe(3);
    expect(failures).toHaveLength(1);
  });

  it('commits object state with the invocation and not before; delayed sends wait for their time', async () => {
    const a: VirtualObjectDefinition<'Chain', { first: (ctx: ObjectContext) => Promise<void>; second: (ctx: ObjectContext, n: number) => Promise<number> }> = { name: 'Chain' };
    const svc = object({ name: 'Chain', handlers: {
      async first(ctx: ObjectContext): Promise<void> {
        ctx.set('state', { n: 1 });
        ctx.objectSendClient<typeof a>(a, ctx.key).second(1, rpc.sendOpts({ delay: 150 }));
      },
      async second(ctx: ObjectContext, n: number): Promise<number> {
        const state = await ctx.get<{ n: number }>('state');
        return (state?.n ?? 0) + n;
      },
    } });
    const runner = make();
    runner.register(svc);
    await runner.start();
    const began = Date.now();
    await runner.invoke({ service: 'Chain', key: 'k', handler: 'first', input: undefined });
    await eventually(async () => expect(await rows("SELECT id FROM invocations WHERE handler = 'second' AND status = 'done'")).toHaveLength(1));
    expect(Date.now() - began).toBeGreaterThanOrEqual(140);
    const [row] = await rows("SELECT result FROM invocations WHERE handler = 'second'");
    expect(row?.['result']).toBe('2');
  });

  it('resumes from the journal when another runner takes over after a stop', async () => {
    let sideEffects = 0;
    let blocked = true;
    const svc = object({ name: 'Resume', handlers: { async go(ctx: ObjectContext): Promise<string> {
      await ctx.run('effect', async () => { sideEffects += 1; return 1; });
      await ctx.run('hang', async () => { if (blocked) await new Promise(() => undefined); return 2; });
      return 'finished';
    } } });
    const first = make();
    first.register(svc);
    await first.start();
    const id = await first.enqueue({ service: 'Resume', key: 'k', handler: 'go', input: undefined });
    await eventually(async () => expect(await rows('SELECT * FROM journal WHERE invocation_id = ?', [id])).toHaveLength(1));
    first.stop();
    blocked = false;
    const second = make();
    second.register(svc);
    await second.start();
    await eventually(async () => expect((await rows('SELECT result FROM invocations WHERE id = ?', [id]))[0]?.['result']).toBe('"finished"'));
    expect(sideEffects).toBe(1);
  });
});
