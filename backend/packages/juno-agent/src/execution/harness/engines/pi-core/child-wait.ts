/**
 * Core-side child wait (PH12): the parent run waits durably for its child tasks.
 *
 * The single-poll loop lives in the task module (modules/tasks/childWait); this adapter supplies
 * the runtime the core owns, using the SDK-branded primitives DIRECTLY: ctx.sleep and ctx.run are
 * handed through, now is the top-level durable clock, and the cancellation race receives the
 * action own branded promise (only the race result is lifted). No request, awakeable or human is
 * involved: the parent stays RUNNING and the model is never asked to answer. The validated
 * tool-result selection and deadline arrive per wait (never model text); the overall deadline is
 * anchored once to the journaled start read, so a restart derives the remainder from the same
 * absolute point instead of resetting the full timeout. Steering input drains at each poll
 * boundary through the caller interrupt and ends the wait as steered while children keep running.
 */
import { RestatePromise } from '@agent-desktop/durable';
import { awaitChildTasks, CHILD_WAIT_POLL_MS, CHILD_WAIT_TIMEOUT_MS, type ChildWaitRuntime } from '../../../../modules/tasks/childWait.js';
import { isTerminal, listChildTasks, type ChildStatus } from '../../../../modules/tasks/child.js';
import { CANCELLED, type RunCancellation } from '../../services/cancel.js';
import type { RunContext, RunServices } from '../../services/run-types.js';

export type ChildWaitResult = 'done' | 'timeout' | 'not_found' | 'cancelled' | 'steered';

/** Validated tool-result wait metadata; absent means every child plus the default deadline. */
export interface ChildWaitSelection {
  runIds?: string[];
  timeoutMs?: number;
  /** Absolute ISO deadline, consumed with the durable clock, never reset on restart. */
  until?: string;
}

/** Steering check at each poll boundary: true ends the wait steered, cancelled stops the run. */
export type ChildWaitInterrupt = () => Promise<boolean | 'cancelled'>;

/** The observed wait outcome the core appends before the next model turn. */
export interface ChildWaitObserved {
  kind: ChildWaitResult;
  children: ChildStatus[];
  missing: string[];
}

export async function runChildWait(
  ctx: RunContext,
  services: RunServices,
  runId: string,
  stepIndex: number,
  cancellation: RunCancellation,
  selection: ChildWaitSelection = {},
  interrupt?: ChildWaitInterrupt,
): Promise<ChildWaitObserved> {
  const sleep = ctx.sleep;
  const date = ctx.date;
  const runtime: ChildWaitRuntime = {
    sleep: sleep === undefined ? (() => RestatePromise.resolve(undefined)) : sleep,
    now: date === undefined ? (() => RestatePromise.resolve(Date.now())) : date.now,
    run: (name, action) => ctx.run(name, action),
    // The action own branded promise goes straight into the durable race; only its result is lifted.
    race: <T>(action: () => RestatePromise<T>): RestatePromise<T | 'cancelled'> =>
      RestatePromise.resolve(cancellation.race(action).then((raced): T | 'cancelled' => (raced === CANCELLED ? 'cancelled' : raced))),
  };
  // One durable start read anchors every slice. The deadline is the earlier of the bounded
  // timeout and the valid absolute instant, with either absent side falling back to the other
  // and both absent keeping the helper default: an already-past deadline therefore performs a
  // single truthful poll with zero sleep instead of waiting out the full timeout.
  const startedAt = await runtime.now();
  const absolute = selection.until === undefined ? NaN : Date.parse(selection.until);
  const bounded = selection.timeoutMs;
  const deadline = bounded === undefined && Number.isNaN(absolute) ? startedAt + CHILD_WAIT_TIMEOUT_MS
    : bounded === undefined ? absolute
    : Number.isNaN(absolute) ? startedAt + bounded
    : Math.min(startedAt + bounded, absolute);
  for (let slice = 0; ; slice += 1) {
    const remaining = deadline - (await runtime.now());
    const outcome = await awaitChildTasks(services.store, {
      parentRunId: runId,
      waitKey: 'step:' + String(stepIndex) + ':slice:' + String(slice),
      ...(selection.runIds === undefined ? {} : { runIds: selection.runIds }),
      timeoutMs: remaining <= 0 ? 0 : Math.min(CHILD_WAIT_POLL_MS, remaining),
    }, runtime);
    if (outcome.kind === 'done') return { kind: 'done', children: outcome.children, missing: [] };
    if (outcome.kind === 'not_found') return { kind: 'not_found', children: [], missing: outcome.missing };
    if (outcome.kind === 'cancelled') return { kind: 'cancelled', children: outcome.children, missing: [] };
    if (deadline - (await runtime.now()) <= 0) {
      return { kind: 'timeout', children: outcome.children, missing: [] };
    }
    if (interrupt !== undefined) {
      const steered = await interrupt();
      if (steered === 'cancelled') return { kind: 'cancelled', children: outcome.children, missing: [] };
      if (steered) {
        const live = await runtime.run('childpoll:' + runId + ':step:' + String(stepIndex) + ':steered', () => listChildTasks(services.store, runId));
        return { kind: 'steered', children: live.filter((child) => !isTerminal(child.status)), missing: [] };
      }
    }
  }
}
