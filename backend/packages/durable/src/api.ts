/**
 * The service-definition and context API the harness is written against (the shape of the Restate SDK it replaces):
 * objects and workflows, ctx.run / sleep / awakeable / promise, typed clients, RestatePromise helpers.
 */

/** Durable operations are plain promises here: there is no replay engine that needs a branded type. */
export type RestatePromise<T> = Promise<T>;
export const RestatePromise = {
  resolve<T>(value: T | PromiseLike<T>): Promise<T> {
    return Promise.resolve(value);
  },
  reject<T = never>(reason: unknown): Promise<T> {
    return Promise.reject(reason);
  },
  all<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
    return Promise.all(values);
  },
  race<T extends readonly unknown[] | []>(values: T): Promise<Awaited<T[number]>> {
    return Promise.race(values);
  },
};

/** Options of a one-way send. */
export class SendOpts {
  constructor(readonly delay?: number, readonly idempotencyKey?: string) {}
}
export const rpc = {
  sendOpts(opts: { delay?: number; idempotencyKey?: string }): SendOpts {
    return new SendOpts(opts.delay, opts.idempotencyKey);
  },
};

export interface VirtualObjectDefinition<N extends string = string, H = unknown> {
  readonly name: N;
  readonly _handlers?: H;
}
export interface WorkflowDefinition<N extends string = string, H = unknown> {
  readonly name: N;
  readonly _handlers?: H;
}
export type AnyDefinition = { readonly name: string; readonly _handlers?: unknown };
export type HandlersOf<D> = D extends { readonly _handlers?: infer H } ? NonNullable<H> : never;

/** Request-response client: each handler returns its result. */
export type ObjectClient<H> = {
  [K in keyof H]: H[K] extends (ctx: never, ...args: infer A) => Promise<infer R> ? (...args: A) => Promise<R> : never;
};
/** One-way client: each handler takes its input and optional send options and returns at once. */
export type ObjectSendClient<H> = {
  [K in keyof H]: H[K] extends (ctx: never, ...args: infer A) => unknown ? (...args: [...A, SendOpts?]) => void : never;
};

export interface DurablePromise<T> {
  peek(): Promise<T | undefined>;
  get(): Promise<T>;
  resolve(value: T): Promise<void>;
}

export interface Clients {
  objectClient<D extends AnyDefinition>(def: D, key: string): ObjectClient<HandlersOf<D>>;
  objectSendClient<D extends AnyDefinition>(def: D, key: string): ObjectSendClient<HandlersOf<D>>;
  workflowClient<D extends AnyDefinition>(def: D, key: string): ObjectClient<HandlersOf<D>>;
  workflowSendClient<D extends AnyDefinition>(def: D, key: string): ObjectSendClient<HandlersOf<D>>;
}

export interface Context extends Clients {
  readonly rand: { uuidv4(): string; random(): number };
  readonly date: { now(): Promise<number> };
  /** 1 on the first try of an invocation; grows with every retry. */
  readonly attempt: number;
  /** True on the last try the runner allows: a failure now ends the invocation. */
  readonly lastAttempt: boolean;
  /** Aborted when the execution's database lease is lost; cooperative work stops at the next boundary. */
  readonly leaseSignal?: AbortSignal;
  run<T>(name: string, action: () => Promise<T> | T): Promise<T>;
  sleep(ms: number): Promise<void>;
  awakeable<T>(): { id: string; promise: Promise<T> };
  resolveAwakeable<T>(id: string, value?: T): void;
}

export interface ObjectSharedContext extends Clients {
  readonly key: string;
  get<T>(name: string): Promise<T | null>;
}
export interface ObjectContext extends Context, ObjectSharedContext {
  set<T>(name: string, value: T): void;
  clear(name: string): void;
}
export interface WorkflowSharedContext extends ObjectSharedContext {
  promise<T = void>(name: string): DurablePromise<T>;
}
export interface WorkflowContext extends ObjectContext, WorkflowSharedContext {}

type AnyHandler = (ctx: never, ...args: never[]) => Promise<unknown>;

/** Marker for handlers that read without queueing behind the key's exclusive handlers. */
export const SHARED = Symbol.for('durable.shared');
const shared = <F extends AnyHandler>(fn: F): F => {
  Object.defineProperty(fn, SHARED, { value: true });
  return fn;
};
export const handlers = { object: { shared }, workflow: { shared } };

/** What a runner registers. */
export interface ServiceDefinition {
  readonly kind: 'object' | 'workflow';
  readonly name: string;
  readonly handlers: Readonly<Record<string, AnyHandler>>;
  /** Called when an invocation ends in terminal failure (a TerminalError, a journal mismatch, retries used up). */
  readonly onFailure?: (info: { key: string; handler: string; input: unknown; message: string }) => Promise<void>;
}

export function object<N extends string, H extends Record<string, AnyHandler>>(spec: {
  name: N;
  handlers: H;
  onFailure?: ServiceDefinition['onFailure'];
}): ServiceDefinition & { readonly name: N; readonly handlers: H } {
  return { kind: 'object', ...spec };
}

/** A workflow's `run` handler executes once per key; every other handler is shared. */
export function workflow<N extends string, H extends Record<string, AnyHandler>>(spec: {
  name: N;
  handlers: H;
  onFailure?: ServiceDefinition['onFailure'];
}): ServiceDefinition & { readonly name: N; readonly handlers: H } {
  return { kind: 'workflow', ...spec };
}

export const isShared = (def: ServiceDefinition, handler: string): boolean => {
  const fn = def.handlers[handler];
  if (fn === undefined) return false;
  if (def.kind === 'workflow') return handler !== 'run';
  return Reflect.get(fn, SHARED) === true;
};
