/**
 * Tool suspension: durable time, event or human waits (approval, secure input, sign-in, take-over).
 *
 * Kept out of the turn driver so it stays readable: time waits use the durable timer; remaining reasons use the ordinary
 * request/awakeable wait. A run never waits for its subagents: their result arrives as a task_done wake.
 */
import type { ToolResult } from '../../../../contracts/index.js';
import { appendToTranscript } from '../../../brain/index.js';
import { CANCELLED, type RunCancellation } from '../../services/cancel.js';
import { awaitUser, drainAndAppend, interruptedNote } from '../../services/run-input.js';
import type { RunContext, RunInput, RunServices } from '../../services/run-types.js';
import { waitForEvent } from './event-wait.js';
import { deferLongWait, waitUntil, waitUntilSteerable } from './time-wait.js';

export interface SuspensionDeps {
  ctx: RunContext;
  services: RunServices;
  input: RunInput;
  runId: string;
  stepIndex: number;
  suspend: NonNullable<ToolResult['suspend']>;
  details?: ToolResult['details'];
  cancellation: RunCancellation;
}

export async function handleSuspension(deps: SuspensionDeps): Promise<'resume' | 'stopped'> {
  const { ctx, services, input, runId, stepIndex, suspend, details, cancellation } = deps;
  if (suspend.reason === 'event') return waitForEvent(deps);
  if (suspend.reason === 'time') {
    // H-74: only a tool result flagged `defer` (journaled) takes the timer-wake path, so a run that was
    // already sleeping before this change replays its original sleep. After deferring, the run resumes
    // for one more model turn so the agent acknowledges instead of ending silently.
    const reason = details === undefined ? undefined : Reflect.get(details, 'reason');
    if (details !== undefined && Reflect.get(details, 'defer') === true) {
      if (await deferLongWait(ctx, input, runId, suspend.until, typeof reason === 'string' ? reason : undefined, stepIndex)) return 'resume';
    }
    // A journaled `steerable` flag takes the sliced wait that new input ends early; older results keep one sleep.
    if (details !== undefined && Reflect.get(details, 'steerable') === true && suspend.until !== undefined) {
      const steer = async (slice: number): Promise<boolean | 'cancelled'> => {
        const drained = await drainAndAppend(ctx, services, input, cancellation, 'timewait:' + String(stepIndex) + ':' + String(slice));
        return drained === CANCELLED ? 'cancelled' : drained;
      };
      const woke = await waitUntilSteerable(ctx, suspend.until, stepIndex, cancellation, steer);
      if (woke !== 'steered') return woke;
      // The wake-up did not happen: say so, so the model does not take the time for passed and calls wake_at again if needed.
      const key = ctx.rand.uuidv4();
      await ctx.run('time-wait-note:' + String(stepIndex), async () => {
        const note = '[internal wake] the wake-up set for ' + suspend.until + ' has not happened yet: new input arrived first. Call wake_at again if you still need it.';
        await appendToTranscript(services.store, input.sessionKey, [{ role: 'user', content: note, timestamp: Date.now() }], key);
      });
      return 'resume';
    }
    return waitUntil(ctx, suspend.until, stepIndex, cancellation);
  }
  const wait = { reason: suspend.reason, ...(suspend.awakeableId === undefined ? {} : { awakeableId: suspend.awakeableId }) };
  const resumed = await awaitUser(ctx, services, input, runId, stepIndex, wait, cancellation);
  if (resumed === 'interrupted_by_message') {
    // The user typed instead of deciding: the request stays open and the model gets the note; the drain after the tool batch adds their message.
    const key = ctx.rand.uuidv4();
    await ctx.run('interrupted-note:' + String(stepIndex), async () => {
      const title = wait.awakeableId === undefined ? undefined : (await services.store.get('requests', wait.awakeableId))?.title;
      await appendToTranscript(services.store, input.sessionKey, [{ role: 'user', content: interruptedNote(title ?? 'your request'), timestamp: Date.now() }], key);
    });
  }
  return resumed === 'cancelled' ? 'stopped' : 'resume';
}
