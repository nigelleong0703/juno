/**
 * Enqueuer: hands wake events and control messages to the in-process durable runner.
 * Implements the Enqueuer interface from the contracts package.
 */

import type { BackgroundCallStart, ChildRunStart, Enqueuer, TaskWatchStart, WakeEvent, Store } from '@agent-desktop/contracts';
import { RESTATE } from '@agent-desktop/contracts';
import { TimeoutError, type Runner } from '@agent-desktop/durable';
import { createLogger } from '@agent-desktop/log';
import { childRunInput, expirePendingRequests } from 'juno-agent/execution/child-run-input';
export { childRunInput } from 'juno-agent/execution/child-run-input';

const log = createLogger({ service: 'agentd' });

/** How long an `awaitDecision` enqueue waits for Session.receive to answer before reporting it unconfirmed. */
export const DECISION_TIMEOUT_MS = 10_000;

/** Reads Session.receive's `{ accepted, reason?, runId? }` answer; anything else is treated as a refusal. */
function readDecision(body: unknown): { accepted: boolean; reason?: string; runId?: string } {
  const accepted: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'accepted') : undefined;
  const reason: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'reason') : undefined;
  const runId: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'runId') : undefined;
  if (typeof accepted !== 'boolean') return { accepted: false, reason: 'unreadable session decision' };
  return {
    accepted,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(typeof runId === 'string' ? { runId } : {}),
  };
}

/**
 * Enqueuer backed by the in-process durable runner.
 * Default: a one-way send to Session[sessionKey].receive(); `accepted` then only means the message is stored.
 * With `awaitDecision` it is a request-response call and `accepted`/`reason` are Session's own verdict.
 */
export class RunnerEnqueuer implements Enqueuer {
  constructor(
    private runner: Runner,
    private store: Store,
    private decisionTimeoutMs: number = DECISION_TIMEOUT_MS,
  ) {}

  async enqueue(event: WakeEvent, opts?: { delayMs?: number; awaitDecision?: boolean }): Promise<{ accepted: boolean; reason?: string; runId?: string }> {
    const delayed = opts?.delayMs !== undefined && opts.delayMs > 0;
    // A delayed delivery has no verdict to wait for, so it is always one-way.
    const awaiting = opts?.awaitDecision === true && !delayed;
    const target = { service: RESTATE.session, key: event.sessionKey, handler: 'receive', input: event };
    try {
      // The idempotency key is kept in both modes: a retry of the same event id is the same delivery, and a retried
      // request-response call returns the first call's verdict.
      if (!awaiting) {
        await this.runner.sendTo(target, { idempotencyKey: event.id, ...(delayed ? { delayMs: Math.round(opts?.delayMs ?? 0) } : {}) });
        return { accepted: true };
      }
      return readDecision(await this.runner.invoke(target, { idempotencyKey: event.id, timeoutMs: this.decisionTimeoutMs }));
    } catch (error) {
      // The call is stored under its idempotency key, so it still runs after a timeout here. Reporting it as not
      // delivered would make the model resend it as a duplicate.
      if (awaiting && error instanceof TimeoutError) {
        return { accepted: true, reason: 'sent; no decision from the session within ' + String(this.decisionTimeoutMs) + 'ms (unconfirmed, do not resend)' };
      }
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Start the reserved child run's Run workflow, keyed by the EXACT run id: a workflow runs once per key, so a retry never starts a second run. */
  async startChildRun(input: ChildRunStart): Promise<void> {
    await this.runner.sendTo({ service: RESTATE.run, key: input.runId, handler: 'run', input: childRunInput(input) });
  }

  /** H-72: start the durable watcher for a background process; the task id keys it, so a retry is a no-op. */
  async watchTask(input: TaskWatchStart): Promise<void> {
    await this.runner.sendTo({ service: RESTATE.taskWatcher, key: input.taskId, handler: 'watch', input }, { idempotencyKey: 'watch-' + input.taskId });
  }

  /** H-73: run an authorized tool call in the background; the task id keys it, so a retry never runs it twice. */
  async startBackgroundCall(input: BackgroundCallStart): Promise<void> {
    await this.runner.sendTo({ service: RESTATE.backgroundCall, key: input.taskId, handler: 'call', input }, { idempotencyKey: 'bgcall-' + input.taskId });
  }

  /** H-79: whether this run's workflow invocation is still waiting or executing; 'none' marks an orphaned row. */
  async runState(runId: string): Promise<'running' | 'none'> {
    return (await this.runner.isLive(RESTATE.run, runId, 'run')) ? 'running' : 'none';
  }

  async releaseSession(sessionKey: string, runId: string): Promise<void> {
    await this.runner.sendTo({ service: RESTATE.session, key: sessionKey, handler: 'runFinished', input: runId });
  }

  async stopRun(runId: string): Promise<void> {
    // Cancel delivery is observable: a failed send throws so a parent cancel can retry instead of
    // reporting success. Requests expire only after the cancel is accepted — never on a failed send
    // — and the run's own terminal state stays authoritative (no fabricated status patch here).
    try {
      await this.runner.sendTo({ service: RESTATE.run, key: runId, handler: 'cancel', input: {} });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error, runId }, 'stopRun: cancel send failed');
      throw new Error('could not stop run ' + runId + ': ' + message, { cause: error });
    }
    await expirePendingRequests(this.store, runId);
  }

  async resolveAwakeable(awakeableId: string, value: unknown): Promise<void> {
    // Delivery must be observable: a swallowed failure would let the route report a resolved request
    // that the suspended run never received. Throw so the caller can surface it and retry. A second
    // resolver of the same awakeable simply loses (first one wins).
    try {
      await this.runner.resolveAwakeable(awakeableId, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error, awakeableId }, 'resolveAwakeable failed');
      throw new Error(`resolveAwakeable failed for ${awakeableId}: ${message}`, { cause: error });
    }
  }

  async scheduleRoutine(routineId: string): Promise<void> {
    let routine: unknown;
    try {
      routine = await this.store.get('routines', routineId);
    } catch (error) {
      log.error({ err: error, routineId }, 'scheduleRoutine: routine read failed, skipping arm');
      return;
    }
    if (routine === null) {
      log.error({ routineId }, 'scheduleRoutine: routine not found, skipping arm');
      return;
    }
    try {
      await this.runner.sendTo({ service: RESTATE.routineTimer, key: routineId, handler: 'arm', input: routine }, { idempotencyKey: `routine-arm-${routineId}-${Date.now()}` });
    } catch (error) {
      log.error({ err: error }, 'scheduleRoutine error');
    }
  }

  /** A monitor's check, now, and what came of it (`woke`, `nothing_new`, `failed`, ...). */
  async checkRoutine(routineId: string): Promise<{ outcome: string }> {
    const answer = await this.runner.invoke({ service: RESTATE.routineTimer, key: routineId, handler: 'checkNow', input: undefined }, { timeoutMs: 90_000 });
    const outcome = typeof answer === 'object' && answer !== null ? Reflect.get(answer, 'outcome') : undefined;
    return { outcome: typeof outcome === 'string' ? outcome : 'unknown' };
  }

  /** Arms, moves or stops the timer of one item of an agent's own calendar, matching what is stored. */
  async scheduleCalendarItem(itemId: string): Promise<void> {
    try {
      await this.runner.sendTo({ service: RESTATE.calendarTimer, key: itemId, handler: 'arm', input: undefined });
    } catch (error) {
      log.error({ err: error, itemId }, 'scheduleCalendarItem error');
    }
  }

  /** Arms the user's hidden background schedules: the memory jobs and the daily ideas job (both idempotent). */
  async scheduleMemoryJobs(ownerId: string): Promise<void> {
    for (const service of [RESTATE.memoryTimer, RESTATE.ideasTimer]) {
      try {
        await this.runner.sendTo({ service, key: ownerId, handler: 'arm', input: undefined });
      } catch (error) {
        log.error({ err: error, service }, 'scheduleMemoryJobs error');
      }
    }
  }

  async routineResultsRead(receipt: { routineId: string; conversationId: string; readCutoff: string; resultIds: string[] }): Promise<void> {
    try {
      await this.runner.sendTo(
        { service: RESTATE.routineTimer, key: receipt.routineId, handler: 'recordRead', input: receipt },
        { idempotencyKey: `routine-read-${receipt.routineId}-${receipt.readCutoff}` },
      );
    } catch (error) {
      log.error({ err: error }, 'routineResultsRead error');
    }
  }
}

/**
 * Noop enqueuer for testing (records calls without side effects).
 */
export class NoopEnqueuer implements Enqueuer {
  async startChildRun(input: ChildRunStart): Promise<void> {
    this.calls.push({ method: 'startChildRun', args: [input.runId] });
  }
  calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(private store?: Store) {}

  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string }> {
    this.calls.push({ method: 'enqueue', args: [event] });
    return { accepted: true };
  }

  async stopRun(runId: string): Promise<void> {
    this.calls.push({ method: 'stopRun', args: [runId] });
  }

  async resolveAwakeable(awakeableId: string, value: unknown): Promise<void> {
    this.calls.push({ method: 'resolveAwakeable', args: [awakeableId, value] });
  }

  async scheduleRoutine(routineId: string): Promise<void> {
    this.calls.push({ method: 'scheduleRoutine', args: [routineId] });
  }

  async scheduleCalendarItem(itemId: string): Promise<void> {
    this.calls.push({ method: 'scheduleCalendarItem', args: [itemId] });
  }

  async routineResultsRead(receipt: unknown): Promise<void> {
    this.calls.push({ method: 'routineResultsRead', args: [receipt] });
  }
}
