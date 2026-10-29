/**
 * The durable child-wait helper the core runs when a tool suspends with reason 'child'.
 *
 * It is deliberately NOT a user wait: the parent stays RUNNING, no request/awakeable is created and no
 * human is asked. The loop is bounded and durable — one journaled poll step per tick, a real durable
 * `ctx.sleep` passed straight through (never wrapped, so the Restate brand survives), and the run's
 * cancellation raced around it — until the children are terminal, the timeout expires, the run is
 * stopped, or the parent is steered. Poll keys are namespaced by the core's own request key, so two
 * waits on the same parent never replay each other's results. The interrupt check runs at the TOP level
 * between polls (never a ctx drain inside the journaled poll action); a steered parent resumes the SAME
 * run instead of waiting out the deadline.
 */
import type { RestatePromise } from '@agent-desktop/durable';
import type { Store } from '../../contracts/index.js';
import { isTerminal, listChildTasks, readChildTask, type ChildStatus } from './child.js';

export const CHILD_WAIT_POLL_MS = 1_000;
export const CHILD_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;

/** The durable capabilities the core supplies; pass `ctx.sleep`/`ctx.date.now`/the cancel race directly. */
export interface ChildWaitRuntime {
  sleep(ms: number): RestatePromise<void>;
  now(): RestatePromise<number>;
  run<T>(name: string, action: () => Promise<T>): RestatePromise<T>;
  race<T>(action: () => RestatePromise<T>): RestatePromise<T | 'cancelled'>;
}

export type ChildWaitOutcome =
  | { kind: 'done'; children: ChildStatus[] }
  | { kind: 'timeout'; children: ChildStatus[] }
  | { kind: 'cancelled'; children: ChildStatus[] }
  | { kind: 'steered'; children: ChildStatus[] }
  | { kind: 'not_found'; missing: string[] };
/** Optional top-level interrupt hook the core supplies (inbox check between polls, never inside ctx.run). */
export interface ChildWaitInterrupts {
  checkInterrupted?: () => Promise<boolean>;
}

export interface ChildWaitRequest {
  parentRunId: string;
  /** The core's own key for THIS wait (its request/step index, never model text): it namespaces polls. */
  waitKey: string;
  /** Restrict the wait to these child runs; omitted waits for every child of the parent. */
  runIds?: string[];
  timeoutMs?: number;
  pollMs?: number;
}

export async function awaitChildTasks(store: Store, request: ChildWaitRequest, runtime: ChildWaitRuntime, interrupts?: ChildWaitInterrupts): Promise<ChildWaitOutcome> {
  const timeoutMs = request.timeoutMs ?? CHILD_WAIT_TIMEOUT_MS;
  const pollMs = Math.max(50, request.pollMs ?? CHILD_WAIT_POLL_MS);
  const startedAt = await runtime.now();
  const prefix = 'childpoll:' + request.parentRunId + ':' + request.waitKey + ':';
  for (let tick = 0; ; tick += 1) {
    const lookup = await runtime.run(prefix + String(tick), () => childrenOf(store, request));
    // A foreign or unknown requested id is reported truthfully — never treated as "all done".
    if (lookup.kind === 'not_found') return { kind: 'not_found', missing: lookup.missing };
    const children = lookup.children;
    if (children.every((child) => isTerminal(child.status))) return { kind: 'done', children };
    if (interrupts?.checkInterrupted !== undefined && (await interrupts.checkInterrupted())) return { kind: 'steered', children };
    const elapsed = (await runtime.now()) - startedAt;
    if (elapsed >= timeoutMs) return { kind: 'timeout', children };
    const raced = await runtime.race(() => runtime.sleep(Math.min(pollMs, timeoutMs - elapsed)));
    if (raced === 'cancelled') return { kind: 'cancelled', children };
  }
}

type ChildrenLookup = { kind: 'ok'; children: ChildStatus[] } | { kind: 'not_found'; missing: string[] };

async function childrenOf(store: Store, request: ChildWaitRequest): Promise<ChildrenLookup> {
  const children = await listChildTasks(store, request.parentRunId);
  if (request.runIds === undefined) return { kind: 'ok', children };
  // The ids were authorized when child_wait started (authorizeOwnChild), so the poll only reads them back, including
  // a child an earlier run of this agent spawned.
  const wanted: ChildStatus[] = [];
  const missing: string[] = [];
  for (const runId of request.runIds) {
    const found = children.find((child) => child.runId === runId) ?? (await readChildTask(store, runId));
    if (found === null) missing.push(runId);
    else wanted.push(found);
  }
  if (missing.length > 0) return { kind: 'not_found', missing };
  return { kind: 'ok', children: wanted };
}
