import { AsyncResource } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { isShared, type AnyDefinition, type HandlersOf, type ObjectClient, type ObjectSendClient, SendOpts, type ServiceDefinition } from './api.js';
import { InvocationContext, type ContextHost, type Target } from './context.js';
import type { DurableDb } from './db.js';
import { JournalMismatchError, RETRIES_EXHAUSTED_MESSAGE, TerminalError } from './errors.js';
import { createLeaseGuard, LeaseLostError, runWithLease, type LeaseGuard } from './lease.js';
import { DurableStore, WORK_CHANNEL, type ClaimedInvocation, type InvocationRow } from './store.js';

export interface RunnerOptions {
  db: DurableDb;
  /** Stable identity written into every lease (default: host, pid and a random suffix). */
  workerId?: string;
  /** False for a process that only stores work and waits for it (the coordinator); it never claims or executes. */
  execute?: boolean;
  /**
   * How many invocations this worker uses at once (default: no bound, as one process that runs everything needs). Execution
   * workers set it so a burst of work is shared with the other workers instead of whoever polls first taking it all; one
   * bound for a whole process would otherwise cap every owner together. An invocation that only waits (an approval, a sleep, a child's result,
   * for longer than a second and a half) keeps its lease and lane but is not counted, so runs parked on people or on children
   * can never fill the worker and starve the work they wait for.
   */
  maxConcurrent?: number;
  /** Lease lifetime in milliseconds (default 15s); renewed every `renewMs`. */
  leaseTtlMs?: number;
  /** Renewal period (default a third of the lease lifetime). */
  renewMs?: number;
  /** Tries per invocation before a retryable failure becomes terminal (default 5). */
  maxAttempts?: number;
  /** Wait before try number `attempt + 1` (default 1s doubling, at most 30s). */
  backoffMs?: (attempt: number) => number;
  /**
   * How often due rows and expired leases are re-scanned even if nothing announced them. With a store that can LISTEN (Postgres)
   * the default is a slow safety net (30s): new work and freed lanes arrive as notifications and the next delayed start or lease
   * expiry is a timer, so an idle worker sends almost no queries. Without LISTEN it is a steady 1s poll.
   */
  sweepMs?: number;
  /** How often another worker's completion / wait resolution is re-read (default 100ms). */
  pollMs?: number;
  /** How long finished invocations are kept for idempotency (default 7 days). */
  retentionMs?: number;
  /** Run the retention prune on start (default true; one coordinator should own it in a split deployment). */
  prune?: boolean;
  /**
   * Pre-claim gate, re-checked every few seconds and on start. agentd passes the coordinator capability/heartbeat
   * check here so a worker stops claiming if the coordinator it depends on is gone (an old-version rollback).
   */
  capabilityCheck?: () => Promise<void>;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

type Outcome = { ok: true; result: string | null } | { ok: false; message: string };
interface Deferred { promise: Promise<Outcome>; resolve(outcome: Outcome): void }
interface Handle {
  lease: ClaimedInvocation;
  guard: LeaseGuard;
  ctx: InvocationContext | undefined;
  /** Open durable waits (sleep, awakeable, call) of the current attempt. */
  waiting: number;
  /** Steps of the current attempt that run this worker's own code (model calls, tools). */
  busy: number;
  /** Since when the invocation has only been waiting (a wait open, no step running); undefined while it works. */
  parkedAt: number | undefined;
  /** Bumped when an attempt ends, so a wait that outlives its attempt cannot change the next attempt's counts. */
  attemptToken: number;
}

/**
 * An invocation that has only waited this long stops counting against the bound. The gaps between a run's steps, and a
 * call that another worker's next sweep (1 s) will serve, are shorter; an approval, a sleep or a child's result are not.
 */
const PARKED_AFTER_MS = 1_500;
/** The safety sweep of a runner that listens for work, and the shortest wait before it looks at a due time again (so an unclaimable due row cannot make it spin). */
const SAFETY_SWEEP_MS = 30_000;
const MIN_DUE_WAIT_MS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));
const parse = (value: string | null): unknown => (value === null ? undefined : JSON.parse(value));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref(); });

/** Ask a send/call to a client outside any handler; every method returns once the work is stored. */
export type ExternalSendClient<H> = { [K in keyof ObjectSendClient<H>]: ObjectSendClient<H>[K] extends (...args: infer A) => void ? (...args: A) => Promise<void> : never };

/**
 * The durable runner. In execution mode it claims due invocations atomically (one exclusive key per claim), renews
 * its leases, and fences every write with its worker identity and epoch. In `execute: false` mode it only stores work
 * and waits for another process to finish it — the coordinator half of a split deployment.
 *
 * Cross-process delivery: waits and completions are re-read from the database, so a run on one worker wakes when
 * another resolves its awakeable or finishes a call it is waiting for. The in-process maps stay as a fast path.
 */
export class Runner implements ContextHost {
  private readonly store: DurableStore;
  private readonly defs = new Map<string, ServiceDefinition>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly completions = new Map<string, Deferred>();
  private readonly waiters = new Map<string, Set<(value: unknown) => void>>();
  private readonly contexts = new Set<InvocationContext>();
  private readonly running = new Map<string, Handle>();
  private readonly workerId: string;
  private readonly executes: boolean;
  private readonly capacity: number;
  private readonly leaseTtlMs: number;
  private readonly renewMs: number;
  private sweepMs: number;
  private readonly pollMs: number;
  /** Stops the LISTEN for new work; set while this runner listens instead of polling. */
  private unlisten: (() => Promise<void>) | undefined;
  /** The one timer for the next delayed start or lease expiry. */
  private dueTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly log: (fields: Record<string, unknown>, message: string) => void;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private idCounter = 0;
  private isStopped = false;
  private ticking = false;
  /** A claim pass was asked for while one was running: run another right after, instead of waiting for the sweep. */
  private tickAgain = false;
  private renewFailures = 0;
  private capabilityOkAt = 0;
  private capabilityGate: Promise<void> | undefined;

  constructor(private readonly options: RunnerOptions) {
    this.store = new DurableStore(options.db);
    this.workerId = options.workerId ?? `${hostname()}:${String(process.pid)}:${randomBytes(3).toString('hex')}`;
    this.executes = options.execute ?? true;
    this.capacity = options.maxConcurrent === undefined ? Number.POSITIVE_INFINITY : Math.max(1, options.maxConcurrent);
    this.leaseTtlMs = Math.max(1, options.leaseTtlMs ?? 15_000);
    this.renewMs = Math.max(1, options.renewMs ?? Math.floor(this.leaseTtlMs / 3));
    this.sweepMs = Math.max(1, options.sweepMs ?? (options.db.listen === undefined ? 1_000 : SAFETY_SWEEP_MS));
    this.pollMs = Math.max(1, options.pollMs ?? 100);
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoff = options.backoffMs ?? ((attempt) => Math.min(30_000, 1000 * 2 ** (attempt - 1)));
    this.log = options.log ?? (() => undefined);
  }

  /** This runner's lease identity; also the fence owner written into every row it claims. */
  get identity(): string {
    return this.workerId;
  }

  get stopped(): boolean {
    return this.isStopped;
  }

  register(...services: ServiceDefinition[]): void {
    for (const service of services) this.defs.set(service.name, service);
  }

  /**
   * Start claiming due work and renewing what this worker runs. An invocation whose lease expired is taken over by
   * `store.claim` like any other due work, at any time; a healthy one owned by another worker is never claimed, so a
   * second worker may start at any time.
   */
  async start(): Promise<void> {
    if (this.isStopped) return;
    if (!this.executes) return;
    await this.gate();
    if (this.options.prune !== false) {
      await this.store.prune(Date.now() - (this.options.retentionMs ?? 7 * DAY_MS)).catch((error: unknown) => this.log({ err: error }, 'durable: prune failed'));
    }
    if (this.options.db.listen !== undefined) {
      try {
        // A notification, and every re-listen after a lost connection (notifications sent meanwhile are gone), asks for a claim pass.
        this.unlisten = await this.options.db.listen(WORK_CHANNEL, () => { void this.tick(); }, () => { void this.tick(); });
      } catch (error) {
        this.log({ err: error }, 'durable: LISTEN failed; polling for work every second instead');
        this.sweepMs = Math.max(1, this.options.sweepMs ?? 1_000);
      }
    }
    this.sweeper = setInterval(() => { void this.tick(); }, this.sweepMs);
    this.sweeper.unref();
    this.heartbeat = setInterval(() => { void this.renewAll(); }, this.renewMs);
    this.heartbeat.unref();
    await this.tick();
  }

  /** Stop scheduling and renewing; running invocations are released so another worker (or the next start) resumes them. */
  stop(): void {
    if (this.isStopped) return;
    this.isStopped = true;
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    if (this.dueTimer !== undefined) clearTimeout(this.dueTimer);
    void this.unlisten?.().catch(() => undefined);
    this.unlisten = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const handle of this.running.values()) {
      handle.guard.lose('the worker stopped');
      handle.ctx?.dispose();
      void this.store.release(handle.lease.fence).catch((error: unknown) => this.log({ err: error, id: handle.lease.id }, 'durable: could not release lease'));
    }
    this.running.clear();
    for (const deferred of this.completions.values()) deferred.resolve({ ok: false, message: 'the worker stopped before the invocation finished' });
    this.completions.clear();
  }

  // ---- claiming ----

  /** Re-run the capability gate at most every few seconds while claiming work. */
  private async gate(): Promise<void> {
    const check = this.options.capabilityCheck;
    if (check === undefined) return;
    if (Date.now() - this.capabilityOkAt < 5_000) return;
    this.capabilityGate ??= check().then(() => { this.capabilityOkAt = Date.now(); }).finally(() => { this.capabilityGate = undefined; });
    await this.capabilityGate;
  }

  /**
   * Claim what this worker has room for. Triggered from inside handlers too (an enqueue, a wait that parks), and an invocation
   * it claims would run in the async context of whoever triggered it: under that handler's lease fence and owner scope, so its
   * reads and writes would be fenced by, and scoped to, an unrelated invocation. Binding the pass to the context the Runner was
   * created in (no lease, no owner) gives every claimed invocation a clean start however the pass was triggered.
   */
  private readonly tick: () => Promise<void> = AsyncResource.bind(() => this.claimLoop());

  private async claimLoop(): Promise<void> {
    if (!this.executes || this.isStopped) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.gate().catch((error: unknown) => {
          this.log({ err: error }, 'durable: capability gate refused new claims');
          throw error;
        });
        while (!this.isStopped && this.executing() < this.capacity) {
          const lease = await this.store.claim(this.workerId, this.leaseTtlMs);
          if (lease === undefined) break;
          this.begin(lease);
        }
      } while (this.tickAgain && !this.isStopped);
      await this.armDue();
    } catch (error) {
      if (!this.isStopped && error instanceof Error && !error.message.includes('capability')) this.log({ err: error }, 'durable: claim failed');
    } finally {
      this.ticking = false;
    }
  }

  /**
   * After a claim pass found nothing more: wake once at the next moment the clock alone makes something claimable (a delayed start,
   * a lease that may have expired), at the latest at the safety sweep. Not while full: a finishing run starts the next pass.
   */
  private async armDue(): Promise<void> {
    if (this.unlisten === undefined || this.isStopped || this.executing() >= this.capacity) return;
    const inMs = await this.store.nextDueInMs();
    if (this.dueTimer !== undefined) clearTimeout(this.dueTimer);
    this.dueTimer = undefined;
    if (inMs === null || this.isStopped) return;
    const timer = setTimeout(() => { if (this.dueTimer === timer) this.dueTimer = undefined; void this.tick(); }, Math.min(Math.max(inMs, MIN_DUE_WAIT_MS), this.sweepMs));
    timer.unref();
    this.dueTimer = timer;
  }

  /** Claimed invocations that are using this worker now: everything except those that have been parked in waits for a while. */
  private executing(): number {
    const now = Date.now();
    let count = 0;
    for (const handle of this.running.values()) if (handle.parkedAt === undefined || now - handle.parkedAt < PARKED_AFTER_MS) count += 1;
    return count;
  }

  private begin(lease: ClaimedInvocation): void {
    const guard = createLeaseGuard(lease.fence);
    const handle: Handle = { lease, guard, ctx: undefined, waiting: 0, busy: 0, parkedAt: undefined, attemptToken: 0 };
    this.running.set(lease.id, handle);
    this.log({ id: lease.id, service: lease.service, key: lease.key, epoch: lease.fence.epoch }, 'durable: claimed');
    void this.run(handle).finally(() => {
      if (this.running.get(lease.id) === handle) this.running.delete(lease.id);
      void this.tick();
    });
  }

  private lose(handle: Handle, reason: string): void {
    if (handle.guard.lost() !== undefined) return;
    this.log({ id: handle.lease.id, service: handle.lease.service, key: handle.lease.key, reason }, 'durable: lease lost; cancelling this execution');
    handle.guard.lose(reason);
    handle.ctx?.dispose();
  }

  private async renewAll(): Promise<void> {
    const handles = [...this.running.values()];
    if (handles.length === 0) return;
    try {
      const lost = new Set(await this.store.renew(handles.map((handle) => handle.lease.fence), this.leaseTtlMs));
      this.renewFailures = 0;
      for (const handle of handles) if (lost.has(handle.lease.id)) this.lose(handle, 'the database no longer recognises this lease');
    } catch (error) {
      this.renewFailures += 1;
      // Three failed renewals span one lease lifetime: stop before another worker may take over.
      if (this.renewFailures >= 3) for (const handle of handles) this.lose(handle, 'lease renewal failed');
      this.log({ err: error, failures: this.renewFailures }, 'durable: lease renewal failed');
    }
  }

  // ---- execution ----

  private async run(handle: Handle): Promise<void> {
    const { id } = handle.lease;
    try {
      const row = await this.store.get(id);
      if (row === undefined || row.status !== 'running') return;
      const def = this.defs.get(row.service);
      const handler = def?.handlers[row.handler];
      if (def === undefined || handler === undefined) {
        await this.fail(handle, row, def, `unknown handler ${row.service}.${row.handler}`);
        return;
      }
      const input = parse(row.input);
      for (let attempt = row.attempt; ; attempt += 1) {
        if (this.isStopped || handle.guard.lost() !== undefined) return;
        if (!(await this.store.markAttempt(id, attempt, handle.lease.fence))) { this.lose(handle, 'attempt write rejected'); return; }
        const ctx = new InvocationContext({
          host: this, invocationId: id, service: row.service, key: row.key, attempt, maxAttempts: this.maxAttempts,
          journal: await this.store.journal(id), state: await this.store.state(row.service, row.key), shared: false,
          signal: handle.guard.signal,
        });
        handle.ctx = ctx;
        this.contexts.add(ctx);
        try {
          const result = await runWithLease(handle.guard, () => (handler as (c: unknown, i: unknown) => Promise<unknown>)(ctx, input));
          await ctx.settle();
          if (this.isStopped || handle.guard.lost() !== undefined) return;
          const finished = await this.store.finish({ status: 'done', result: json(result), error: null }, this.stateWrite(row, ctx), handle.lease.fence);
          if (!finished) { this.lose(handle, 'finish rejected by the database fence'); return; }
          this.complete(id, { ok: true, result: json(result) });
          return;
        } catch (error) {
          await ctx.settle().catch(() => undefined);
          if (this.isStopped || handle.guard.lost() !== undefined || error instanceof LeaseLostError) {
            this.lose(handle, 'the invocation stopped writing after its lease was lost');
            return;
          }
          if (error instanceof TerminalError) { await this.fail(handle, row, def, error.message, this.stateWrite(row, ctx)); return; }
          if (attempt >= this.maxAttempts) {
            this.log({ err: error, id, service: row.service, handler: row.handler }, 'durable: retries exhausted');
            await this.fail(handle, row, def, RETRIES_EXHAUSTED_MESSAGE);
            return;
          }
          this.log({ err: error, id, service: row.service, handler: row.handler, attempt }, 'durable: attempt failed, retrying');
          await sleep(this.backoff(attempt));
        } finally {
          ctx.dispose();
          this.contexts.delete(ctx);
          handle.ctx = undefined;
          handle.waiting = 0;
          handle.busy = 0;
          handle.parkedAt = undefined;
          handle.attemptToken += 1;
        }
      }
    } catch (error) {
      if (!this.isStopped && handle.guard.lost() === undefined) this.log({ err: error, id }, 'durable: invocation could not be run');
    }
  }

  private stateWrite(row: InvocationRow, ctx: InvocationContext): { service: string; key: string; json: string } | undefined {
    const state = ctx.dirtyState;
    return state === undefined ? undefined : { service: row.service, key: row.key, json: JSON.stringify(state) };
  }

  private async fail(handle: Handle, row: InvocationRow, def: ServiceDefinition | undefined, message: string, state?: { service: string; key: string; json: string }): Promise<void> {
    const finished = await this.store.finish({ status: 'failed', result: null, error: message }, state, handle.lease.fence);
    if (!finished) { this.lose(handle, 'failure write rejected by the database fence'); return; }
    this.complete(row.id, { ok: false, message });
    try {
      await def?.onFailure?.({ key: row.key, handler: row.handler, input: parse(row.input), message });
    } catch (error) {
      this.log({ err: error, id: row.id }, 'durable: onFailure hook failed');
    }
  }

  // ---- delivery ----

  private newId(): string {
    return `${Date.now().toString(36).padStart(9, '0')}-${(this.idCounter++).toString(36).padStart(5, '0')}-${randomBytes(3).toString('hex')}`;
  }

  private definition(service: string, handler: string): ServiceDefinition {
    const def = this.defs.get(service);
    if (def === undefined || def.handlers[handler] === undefined) throw new Error(`unknown durable handler ${service}.${handler}`);
    return def;
  }

  /** Store one invocation of an exclusive handler and let a worker claim it; a repeated idempotency key is the same invocation. */
  async enqueue(target: Target, opts: { delayMs?: number; idempotencyKey?: string } = {}): Promise<string> {
    const def = this.definition(target.service, target.handler);
    const now = Date.now();
    const workflowOnce = def.kind === 'workflow' && target.handler === 'run' ? `wf:${target.service}/${target.key}` : undefined;
    const idempotency = workflowOnce ?? (opts.idempotencyKey === undefined ? null : `${target.service}/${target.key}/${target.handler}/${opts.idempotencyKey}`);
    const delay = opts.delayMs !== undefined && opts.delayMs > 0 ? opts.delayMs : 0;
    const { id, created } = await this.store.insert({
      id: this.newId(), service: target.service, key: target.key, handler: target.handler,
      input: json(target.input), notBefore: delay > 0 ? now + delay : null, idempotencyKey: idempotency, now,
    });
    if (created && delay > 0) this.arm(delay);
    void this.tick();
    return id;
  }

  /** Look at due work again when a locally inserted delay expires; the sweep covers rows other workers insert. */
  private arm(delayMs: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); void this.tick(); }, Math.min(delayMs, MAX_TIMER_MS));
    timer.unref();
    this.timers.add(timer);
  }

  private deferred(id: string): Deferred {
    const existing = this.completions.get(id);
    if (existing !== undefined) return existing;
    let resolve: (outcome: Outcome) => void = () => undefined;
    const promise = new Promise<Outcome>((r) => { resolve = r; });
    const created: Deferred = { promise, resolve };
    this.completions.set(id, created);
    // Another process may own this invocation: its result only exists in the database.
    void (async () => {
      while (!this.isStopped) {
        await sleep(this.pollMs);
        if (this.completions.get(id) !== created) return;
        const row = await this.store.get(id).catch(() => undefined);
        if (row?.status === 'done') { this.complete(id, { ok: true, result: row.result }); return; }
        if (row?.status === 'failed') { this.complete(id, { ok: false, message: row.error ?? 'failed' }); return; }
        if (row === undefined && this.completions.get(id) === created) { this.complete(id, { ok: false, message: 'the invocation was deleted' }); return; }
      }
    })();
    return created;
  }

  private complete(id: string, outcome: Outcome): void {
    const d = this.completions.get(id);
    this.completions.delete(id);
    d?.resolve(outcome);
  }

  /** The stored outcome of an invocation, waiting for it to finish (locally or on another worker). */
  private async outcomeOf(id: string): Promise<Outcome> {
    const d = this.deferred(id);
    const row = await this.store.get(id);
    if (row?.status === 'done') { this.completions.delete(id); return { ok: true, result: row.result }; }
    if (row?.status === 'failed') { this.completions.delete(id); return { ok: false, message: row.error ?? 'failed' }; }
    if (row === undefined) { this.completions.delete(id); return { ok: false, message: 'the invocation was deleted' }; }
    return d.promise;
  }

  // ---- ContextHost ----

  async putJournal(invocationId: string, seq: number, name: string, result: string | null, error: string | null): Promise<boolean> {
    const handle = this.running.get(invocationId);
    if (handle === undefined) return false;
    handle.guard.assertOwned();
    return this.store.putJournal(invocationId, seq, name, result, error, handle.lease.fence);
  }

  readState(service: string, key: string): Promise<Record<string, unknown>> {
    return this.store.state(service, key);
  }

  suspend(invocationId: string): () => void {
    return this.track(invocationId, 'waiting');
  }

  busy(invocationId: string): () => void {
    return this.track(invocationId, 'busy');
  }

  /**
   * Count one open wait or running step on the invocation's current attempt; the returned function ends it (once, and only for
   * that attempt). The invocation counts as parked once it has waits open and no step running; the claim loop looks again when
   * the parked time passes `PARKED_AFTER_MS`, since nothing else would wake it.
   */
  private track(invocationId: string, counter: 'waiting' | 'busy'): () => void {
    const handle = this.running.get(invocationId);
    if (handle === undefined) return () => undefined;
    const token = handle.attemptToken;
    const settle = (): void => {
      const parked = handle.waiting > 0 && handle.busy === 0;
      if (parked && handle.parkedAt === undefined) { handle.parkedAt = Date.now(); this.arm(PARKED_AFTER_MS + 10); }
      if (!parked) handle.parkedAt = undefined;
    };
    handle[counter] += 1;
    settle();
    let ended = false;
    return () => {
      if (ended || handle.attemptToken !== token) return;
      ended = true;
      handle[counter] -= 1;
      settle();
    };
  }

  async call(target: Target, idempotencyKey: string): Promise<unknown> {
    const def = this.definition(target.service, target.handler);
    if (isShared(def, target.handler)) return this.runShared(def, target);
    const id = await this.enqueue(target, { idempotencyKey });
    const outcome = await this.outcomeOf(id);
    if (!outcome.ok) throw new TerminalError(outcome.message);
    return parse(outcome.result);
  }

  async send(target: Target, delayMs: number | undefined, idempotencyKey: string): Promise<void> {
    const def = this.definition(target.service, target.handler);
    if (isShared(def, target.handler)) { await this.runShared(def, target); return; }
    await this.enqueue(target, { ...(delayMs === undefined ? {} : { delayMs }), idempotencyKey });
  }

  /** Shared handlers run at once without a stored invocation and never queue behind the key's exclusive ones. */
  private async runShared(def: ServiceDefinition, target: Target): Promise<unknown> {
    const handler = def.handlers[target.handler] as (c: unknown, i: unknown) => Promise<unknown>;
    const ctx = new InvocationContext({
      host: this, invocationId: `shared-${this.newId()}`, service: target.service, key: target.key, attempt: 1, maxAttempts: 1,
      journal: new Map(), state: {}, shared: true,
    });
    try {
      return parse(json(await handler(ctx, parse(json(target.input)))));
    } finally {
      await ctx.settle().catch(() => undefined);
      ctx.dispose();
    }
  }

  openWait(id: string, invocationId: string | null, kind: string): Promise<void> {
    return this.store.openWait(id, invocationId, kind, Date.now());
  }

  /** First resolver wins; returns whether this call was it. */
  async resolveWait(id: string, kind: string, value: unknown): Promise<boolean> {
    const stored = json(value);
    const applied = await this.store.resolveWait(id, kind, stored, Date.now());
    if (applied) for (const listener of [...(this.waiters.get(id) ?? [])]) listener(parse(stored));
    return applied;
  }

  /** Delete everything stored under these session / run / timer keys (account deletion); see `DurableStore.forget`. */
  forget(keys: { exact: readonly string[]; prefixes: readonly string[] }): Promise<number> {
    return this.store.forget(keys);
  }

  waitResolved(id: string): { promise: Promise<unknown>; cancel(): void } {
    let listener: (value: unknown) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => { listener = resolve; fail = reject; });
    const set = this.waiters.get(id) ?? new Set<(value: unknown) => void>();
    set.add(listener);
    this.waiters.set(id, set);
    let cancelled = false;
    // Listener first, then the read: a resolve between the two reaches the listener. A resolution made by another
    // worker only exists in the database, so poll while that is possible.
    void this.store.wait(id).then((row) => { if (row?.resolvedAt !== null && row?.resolvedAt !== undefined) listener(parse(row.value)); }, fail);
    void (async () => {
      while (!cancelled && !this.isStopped) {
        await sleep(this.pollMs);
        if (cancelled || this.isStopped) return;
        try {
          const row = await this.store.wait(id);
          if (row?.resolvedAt !== null && row?.resolvedAt !== undefined) { listener(parse(row.value)); return; }
        } catch (error) { fail(error); return; }
      }
    })();
    return {
      promise,
      cancel: () => { cancelled = true; set.delete(listener); if (set.size === 0) this.waiters.delete(id); },
    };
  }

  async peekWait(id: string): Promise<{ value: unknown } | undefined> {
    const row = await this.store.wait(id);
    return row?.resolvedAt === null || row === undefined ? undefined : { value: parse(row.value) };
  }

  // ---- the outside world (enqueuer, tests) ----

  /** Resolve an awakeable from outside; false when it was already resolved. */
  resolveAwakeable(id: string, value: unknown): Promise<boolean> {
    return this.resolveWait(id, 'awakeable', value);
  }

  /** True while the invocation of this handler is waiting or executing. */
  isLive(service: string, key: string, handler: string): Promise<boolean> {
    return this.store.live(service, key, handler);
  }

  /** Start an invocation and wait for its result. */
  async invoke(target: Target, opts: { idempotencyKey?: string; timeoutMs?: number } = {}): Promise<unknown> {
    const def = this.definition(target.service, target.handler);
    if (isShared(def, target.handler)) return this.runShared(def, target);
    const id = await this.enqueue(target, opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey });
    const waiting = this.outcomeOf(id);
    const outcome = opts.timeoutMs === undefined ? await waiting : await Promise.race([waiting, timeout(opts.timeoutMs)]);
    if (!outcome.ok) throw new TerminalError(outcome.message);
    return parse(outcome.result);
  }

  /** One-way send from outside; resolves once the invocation is stored. */
  async sendTo(target: Target, opts: { delayMs?: number; idempotencyKey?: string } = {}): Promise<void> {
    const def = this.definition(target.service, target.handler);
    if (isShared(def, target.handler)) { await this.runShared(def, target); return; }
    await this.enqueue(target, opts);
  }

  objectSendClient<D extends AnyDefinition>(def: D, key: string): ExternalSendClient<HandlersOf<D>> {
    return externalClient((handler, args) => {
      const last = args.at(-1);
      const opts = last instanceof SendOpts ? last : undefined;
      return this.sendTo({ service: def.name, key, handler, input: args[0] instanceof SendOpts ? undefined : args[0] }, {
        ...(opts?.delay === undefined ? {} : { delayMs: opts.delay }), ...(opts?.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
      });
    });
  }

  objectClient<D extends AnyDefinition>(def: D, key: string): ObjectClient<HandlersOf<D>> {
    return externalClient((handler, args) => this.invoke({ service: def.name, key, handler, input: args[0] }));
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => { const t = setTimeout(() => reject(new TimeoutError(ms)), ms); t.unref(); });
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`no answer within ${String(ms)}ms`);
    this.name = 'TimeoutError';
  }
}

function externalClient<T>(make: (handler: string, args: unknown[]) => Promise<unknown>): T {
  const proxy: unknown = new Proxy({}, {
    get: (_target, prop) => (typeof prop === 'string' && prop !== 'then' ? (...args: unknown[]) => make(prop, args) : undefined),
  });
  return proxy as T;
}

export const createRunner = (options: RunnerOptions): Runner => new Runner(options);
export { JournalMismatchError };
