import { createHash } from 'node:crypto';
import {
  SendOpts,
  type AnyDefinition,
  type DurablePromise,
  type HandlersOf,
  type ObjectClient,
  type ObjectSendClient,
  type WorkflowContext,
} from './api.js';
import { JournalMismatchError, TerminalError } from './errors.js';
import { LeaseLostError } from './lease.js';
import type { JournalEntry } from './store.js';

/** What a context needs from its runner. */
export interface ContextHost {
  readonly stopped: boolean;
  /** Fenced journal append: false means this worker no longer owns the invocation. */
  putJournal(invocationId: string, seq: number, name: string, result: string | null, error: string | null): Promise<boolean>;
  /** Run a handler of any service once and wait for its result (shared handlers run inline). */
  call(target: Target, idempotencyKey: string): Promise<unknown>;
  send(target: Target, delayMs: number | undefined, idempotencyKey: string): Promise<void>;
  openWait(id: string, invocationId: string | null, kind: string): Promise<void>;
  resolveWait(id: string, kind: string, value: unknown): Promise<boolean>;
  /** Resolves with the wait's value once it is resolved; `cancel` removes the listener. */
  waitResolved(id: string): { promise: Promise<unknown>; cancel(): void };
  peekWait(id: string): Promise<{ value: unknown } | undefined>;
  readState(service: string, key: string): Promise<Record<string, unknown>>;
  /**
   * The invocation opens a wait on something nobody here computes (a sleep, an awakeable, another invocation's
   * result); the returned function closes it. An invocation that only waits for a while keeps its lease and lane but
   * stops counting against the worker's concurrency, so runs waiting on approvals or children cannot fill every
   * slot and starve the work they wait for.
   */
  suspend(invocationId: string): () => void;
  /** The invocation starts running its own code in a step (a model call, a tool); the returned function ends it. Work keeps the slot even while a wait is open beside it. */
  busy(invocationId: string): () => void;
}

export interface Target {
  service: string;
  key: string;
  handler: string;
  input: unknown;
}

export interface ContextInit {
  host: ContextHost;
  invocationId: string;
  service: string;
  key: string;
  attempt: number;
  maxAttempts: number;
  journal: Map<number, JournalEntry>;
  state: Record<string, unknown>;
  /** A shared handler: no journal, state reads go to the database. */
  shared: boolean;
  /** Aborted when the database lease is lost; the run loop stops cooperating at its next boundary. */
  signal?: AbortSignal;
}

const noop = (): void => undefined;
const MAX_TIMER_MS = 2 ** 31 - 1;

function client<T>(make: (handler: string, args: unknown[]) => unknown): T {
  const proxy: unknown = new Proxy({}, {
    get: (_target, prop) => (typeof prop === 'string' && prop !== 'then' ? (...args: unknown[]) => make(prop, args) : undefined),
  });
  return proxy as T;
}

/** A terminal failure as the journal keeps it, with the metadata callers read from it. */
function savedError(raw: string): TerminalError {
  const parsed: unknown = JSON.parse(raw);
  const message = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'message') : undefined;
  const metadata = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'metadata') : undefined;
  return new TerminalError(typeof message === 'string' ? message : raw, typeof metadata === 'object' && metadata !== null ? { metadata: metadata as Record<string, string> } : undefined);
}

function splitArgs(args: unknown[]): { input: unknown; opts: SendOpts | undefined } {
  const last = args.at(-1);
  const opts = last instanceof SendOpts ? last : undefined;
  return { input: args[0] instanceof SendOpts ? undefined : args[0], opts };
}

/** The context one attempt of one invocation runs with. */
export class InvocationContext implements WorkflowContext {
  readonly key: string;
  readonly attempt: number;
  readonly lastAttempt: boolean;
  readonly leaseSignal: AbortSignal | undefined;
  readonly rand: { uuidv4(): string; random(): number };
  readonly date: { now(): Promise<number> };
  private seq = 0;
  private closed = false;
  private dirty = false;
  private chain: Promise<void> = Promise.resolve();
  private effectErrors: unknown[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly cancellers = new Set<() => void>();

  constructor(private readonly init: ContextInit) {
    this.key = init.key;
    this.attempt = init.attempt;
    this.lastAttempt = init.attempt >= init.maxAttempts;
    this.leaseSignal = init.signal;
    let counter = 0;
    const bytes = (): Buffer => createHash('sha256').update(`${init.invocationId}:rand:${String(counter++)}`).digest();
    this.rand = {
      uuidv4: () => {
        const b = bytes();
        b[6] = (b[6] ?? 0) & 0x0f | 0x40;
        b[8] = (b[8] ?? 0) & 0x3f | 0x80;
        const hex = b.subarray(0, 16).toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      },
      random: () => bytes().readUInt32BE(0) / 2 ** 32,
    };
    this.date = { now: () => this.journaled('@date', () => Promise.resolve(Date.now())) };
  }

  get dirtyState(): Record<string, unknown> | undefined {
    return this.dirty ? this.init.state : undefined;
  }

  /** End of an attempt: nothing of it may write again, and its timers and listeners go. */
  dispose(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const cancel of this.cancellers) cancel();
    this.cancellers.clear();
  }

  /** Wait for the sends and resolves this attempt issued; the first failure is thrown. */
  async settle(): Promise<void> {
    await this.chain;
    const first = this.effectErrors[0];
    if (first !== undefined) throw first;
  }

  private effect(work: () => Promise<unknown>): void {
    this.chain = this.chain.then(work).then(noop, (error: unknown) => { this.effectErrors.push(error); });
  }

  /** Run once and journal the outcome by sequence number; a replay returns the saved outcome and checks the name. */
  private journaled<T>(name: string, action: () => Promise<T> | T): Promise<T> {
    const seq = this.init.shared ? -1 : this.seq++;
    const promise = this.step(seq, name, action);
    promise.catch(noop);
    return promise;
  }

  private async step<T>(seq: number, name: string, action: () => Promise<T> | T): Promise<T> {
    const saved = this.init.journal.get(seq);
    if (saved !== undefined) {
      if (saved.name !== name) throw new JournalMismatchError(seq, saved.name, name);
      if (saved.error !== null) throw savedError(saved.error);
      return saved.result === null ? undefined as T : JSON.parse(saved.result) as T;
    }
    let value: T;
    // A step that runs this worker's own code (a model call, a tool) is work; a call into another invocation only waits for it.
    const done = name.startsWith('@call ') ? noop : this.init.host.busy(this.init.invocationId);
    try {
      value = await action();
    } catch (error) {
      if (error instanceof TerminalError && !(error instanceof JournalMismatchError)) await this.record(seq, name, null, JSON.stringify({ message: error.message, metadata: error.metadata }));
      throw error;
    } finally {
      done();
    }
    await this.record(seq, name, value === undefined ? null : JSON.stringify(value), null);
    return value;
  }

  private async record(seq: number, name: string, result: string | null, error: string | null): Promise<void> {
    if (this.closed || this.init.shared || this.init.host.stopped) return;
    if (this.init.signal?.aborted === true) throw new LeaseLostError('the execution was cancelled');
    if (!(await this.init.host.putJournal(this.init.invocationId, seq, name, result, error))) {
      throw new LeaseLostError('journal write rejected by the database fence');
    }
  }

  run<T>(name: string, action: () => Promise<T> | T): Promise<T> {
    return this.journaled(name, action);
  }

  sleep(ms: number): Promise<void> {
    const until = Date.now() + Math.max(0, ms);
    const promise = this.journaled('@sleep', () => Promise.resolve(until)).then((wakeAt) => this.delay(wakeAt));
    promise.catch(noop);
    return promise;
  }

  private delay(wakeAt: number): Promise<void> {
    const resume = this.init.host.suspend(this.init.invocationId);
    return new Promise<void>((resolve) => {
      const signal = this.init.signal;
      const onAbort = (): void => { signal?.removeEventListener('abort', onAbort); resolve(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const tick = (): void => {
        const left = wakeAt - Date.now();
        if (left <= 0 || signal?.aborted === true) { signal?.removeEventListener('abort', onAbort); resolve(); return; }
        const timer = setTimeout(() => { this.timers.delete(timer); tick(); }, Math.min(left, MAX_TIMER_MS));
        this.timers.add(timer);
      };
      if (!this.closed) tick();
    }).finally(resume);
  }

  awakeable<T>(): { id: string; promise: Promise<T> } {
    const seq = this.seq++;
    const id = `awk_${this.init.invocationId}_${String(seq)}`;
    const promise = (async (): Promise<T> => {
      const saved = this.init.journal.get(seq);
      if (saved !== undefined && saved.name !== '@awakeable') throw new JournalMismatchError(seq, saved.name, '@awakeable');
      if (saved === undefined) await this.record(seq, '@awakeable', null, null);
      await this.init.host.openWait(id, this.init.invocationId, 'awakeable');
      const resume = this.init.host.suspend(this.init.invocationId);
      try {
        return (await this.listen(id)) as T;
      } finally {
        resume();
      }
    })();
    promise.catch(noop);
    return { id, promise };
  }

  private listen(id: string): Promise<unknown> {
    const waiting = this.init.host.waitResolved(id);
    this.cancellers.add(waiting.cancel);
    const signal = this.init.signal;
    if (signal === undefined) return waiting.promise;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => { waiting.cancel(); this.cancellers.delete(waiting.cancel); reject(new LeaseLostError('the execution was cancelled')); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.promise.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }

  resolveAwakeable<T>(id: string, value?: T): void {
    this.seq += 1;
    this.effect(() => this.init.host.resolveWait(id, 'awakeable', value));
  }

  promise<T = void>(name: string): DurablePromise<T> {
    const id = `promise:${this.init.service}:${this.init.key}:${name}`;
    const kind = name === 'cancel' ? 'cancel' : 'promise';
    const host = this.init.host;
    return {
      peek: async () => (await host.peekWait(id))?.value as T | undefined,
      get: () => this.listen(id) as Promise<T>,
      resolve: async (value) => { await host.resolveWait(id, kind, value); },
    };
  }

  async get<T>(name: string): Promise<T | null> {
    const state = this.init.shared ? await this.init.host.readState(this.init.service, this.init.key) : this.init.state;
    return name in state ? state[name] as T : null;
  }

  set<T>(name: string, value: T): void {
    this.init.state[name] = value;
    this.dirty = true;
  }

  clear(name: string): void {
    delete this.init.state[name];
    this.dirty = true;
  }

  private callTarget(service: string, key: string, handler: string, input: unknown): Promise<unknown> {
    const seq = this.init.shared ? -1 : this.seq;
    return this.journaled(`@call ${service}.${handler}`, async () => {
      const resume = this.init.host.suspend(this.init.invocationId);
      try {
        return await this.init.host.call({ service, key, handler, input }, `${this.init.invocationId}:${String(seq)}`);
      } finally {
        resume();
      }
    });
  }

  private sendTarget(service: string, key: string, handler: string, input: unknown, opts: SendOpts | undefined): void {
    const idempotencyKey = opts?.idempotencyKey ?? `${this.init.invocationId}:${String(this.seq)}`;
    this.seq += 1;
    this.effect(() => this.init.host.send({ service, key, handler, input }, opts?.delay, idempotencyKey));
  }

  objectClient<D extends AnyDefinition>(def: D, key: string): ObjectClient<HandlersOf<D>> {
    return client((handler, args) => this.callTarget(def.name, key, handler, args[0]));
  }

  objectSendClient<D extends AnyDefinition>(def: D, key: string): ObjectSendClient<HandlersOf<D>> {
    return client((handler, args) => { const { input, opts } = splitArgs(args); this.sendTarget(def.name, key, handler, input, opts); });
  }

  workflowClient<D extends AnyDefinition>(def: D, key: string): ObjectClient<HandlersOf<D>> {
    return this.objectClient(def, key);
  }

  workflowSendClient<D extends AnyDefinition>(def: D, key: string): ObjectSendClient<HandlersOf<D>> {
    return this.objectSendClient(def, key);
  }
}
