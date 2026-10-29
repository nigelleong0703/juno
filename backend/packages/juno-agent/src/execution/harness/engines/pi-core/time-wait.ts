import { TerminalError } from '@agent-desktop/durable';
import { CANCELLED, type RunCancellation } from '../../services/cancel.js';
import type { RunContext, RunInput } from '../../services/run-types.js';
import { buildCompletionWake } from '../../services/completion-wake.js';

/**
 * A short wake_at sleep that new input can end (the wake_at result carries `steerable`, journaled, so a
 * run already sleeping before this change keeps its single sleep on replay). It sleeps in slices and
 * drains the inbox at each boundary, so a task_done or a message is read within a second instead of
 * after the sleep. Every slice has its own journal names. Returns 'steered' when input arrived first.
 */
/**
 * Journal slice of a steerable wake_at: a steer reaches the sleeping run within one slice. Coarser than the
 * 1 s child-wait poll so a 2-minute wait writes about 24 sleeps, not about 120.
 */
export const STEER_WAIT_SLICE_MS = 5_000;

export async function waitUntilSteerable(
  ctx: RunContext, until: string, stepIndex: number, cancellation: RunCancellation,
  steer: (slice: number) => Promise<boolean | 'cancelled'>,
): Promise<'resume' | 'stopped' | 'steered'> {
  const deadline = Date.parse(until);
  if (!Number.isFinite(deadline)) throw new TerminalError('Time wait deadline malformed');
  const sleep = ctx.sleep;
  if (sleep === undefined) throw new TerminalError('Time wait requires a durable timer');
  for (let slice = 0; ; slice += 1) {
    if (await cancellation.peek()) return 'stopped';
    const now = ctx.date === undefined
      ? await ctx.run('time-wait-clock:' + String(stepIndex) + ':' + String(slice), async () => Date.now())
      : await ctx.date.now();
    const remaining = deadline - now;
    if (remaining <= 0) return 'resume';
    const drained = await steer(slice);
    if (drained === 'cancelled') return 'stopped';
    if (drained) return 'steered';
    const outcome = await cancellation.race(() => sleep(Math.min(STEER_WAIT_SLICE_MS, remaining)));
    if (outcome === CANCELLED) return 'stopped';
  }
}

/** Absolute deadlines and SDK sleep survive replay without restarting the waiting interval. */
export async function waitUntil(
  ctx: RunContext, until: string | undefined, stepIndex: number, cancellation: RunCancellation,
): Promise<'resume' | 'stopped'> {
  const deadline = until === undefined ? NaN : Date.parse(until);
  if (!Number.isFinite(deadline)) throw new TerminalError('Time wait deadline malformed');
  if (await cancellation.peek()) return 'stopped';
  const now = ctx.date === undefined
    ? await ctx.run('time-wait-clock:' + String(stepIndex), async () => Date.now())
    : await ctx.date.now();
  const remaining = deadline - now;
  if (remaining <= 0) return 'resume';
  const sleep = ctx.sleep;
  if (sleep === undefined) throw new TerminalError('Time wait requires a durable timer');
  const outcome = await cancellation.race(() => sleep(remaining));
  return outcome === CANCELLED ? 'stopped' : 'resume';
}

/** H-74: waits longer than this end the turn and come back as a timer wake instead of holding the run. */
export const WAKE_DEFER_THRESHOLD_MS = 2 * 60_000;

/**
 * A long wake_at: schedule a delayed `timer` wake to this run's own session and let the turn end, so
 * the agent is free (other messages start runs) until the time comes. The clock read is durable and
 * the delayed send is journaled by Restate, so a replay schedules it once. Returns false (caller keeps
 * the in-run sleep) for short waits or when this runtime cannot send wakes.
 */
export async function deferLongWait(
  ctx: RunContext, input: RunInput, runId: string, until: string | undefined, reason: string | undefined, stepIndex: number,
): Promise<boolean> {
  const send = ctx.sendWake;
  const deadline = until === undefined ? NaN : Date.parse(until);
  if (send === undefined || !Number.isFinite(deadline)) return false;
  const now = ctx.date === undefined
    ? await ctx.run('wake-defer-clock:' + String(stepIndex), async () => Date.now())
    : await ctx.date.now();
  const remaining = deadline - now;
  if (remaining <= WAKE_DEFER_THRESHOLD_MS) return false;
  const first = input.wakeEvents[0];
  if (first === undefined) return false;
  const wake = buildCompletionWake(
    { ownerId: first.ownerId, agentId: input.agentId, conversationId: input.conversationId, ...(first.hop === undefined ? {} : { hop: first.hop }) },
    'timer', runId + ':wake:' + String(stepIndex), { text: reason ?? 'the wake-up you scheduled', until: new Date(deadline).toISOString(), originRunId: runId }, new Date(deadline).toISOString(),
  );
  send(wake, remaining);
  return true;
}
