/**
 * Tool suspension: durable time, child-task or human waits (approval, secure input, sign-in, take-over).
 *
 * Kept out of the turn driver so it stays readable: the child wait never becomes a human wait (the
 * parent keeps running and the model is never asked), time waits use the durable timer; remaining reasons use the ordinary
 * request/awakeable wait. The child selection and deadline come from the validated tool result
 * (explicit ids, then the tool recorded waiting list, then every child; explicit timeout, then the
 * recorded absolute deadline, then the helper default), and the observed outcome is journaled as
 * an internal note before the next model turn, never a fake user request. Steering input drains
 * at each poll boundary and resumes the parent with the actual user transcript; only a stop that
 * lands while waiting ends the run, and then nothing is journaled. Other outcomes resume.
 */
import { TerminalError } from '@agent-desktop/durable';
import { z } from 'zod';
import type { UserMessage } from '@earendil-works/pi-ai';
import { appendToTranscript } from '../../../brain/index.js';
import type { Store, ToolResult } from '../../../../contracts/index.js';
import { isTerminal } from '../../../../modules/tasks/child.js';
import { artifactNotice, captureOutputArtifact } from '../../../../modules/tools/outputArtifacts.js';
import { redactText } from '../../services/tool-projection.js';
import { CANCELLED, type RunCancellation } from '../../services/cancel.js';
import { awaitUser, drainAndAppend, interruptedNote } from '../../services/run-input.js';
import type { RunContext, RunInput, RunServices } from '../../services/run-types.js';
import { waitForEvent } from './event-wait.js';
import { deferLongWait, waitUntil, waitUntilSteerable } from './time-wait.js';
import { runChildWait, type ChildWaitObserved } from './child-wait.js';

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
/** Strict id list: absent means unsettled, present wins even when empty, malformed fails loudly. */
function strictIds(source: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = z.array(z.string().min(1)).max(50).safeParse(value);
  if (!parsed.success) {
    throw new TerminalError('child wait selection malformed');
  }
  return parsed.data;
}
/** Strict timeout: absent means unsettled, present must be a positive integer. */
function strictTimeout(source: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = z.number().int().positive().safeParse(value);
  if (!parsed.success) {
    throw new TerminalError('child wait timeout malformed');
  }
  return parsed.data;
}
/** Strict deadline: absent means unsettled, present must parse as a date. */
function strictUntil(source: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) {
    throw new TerminalError('child wait deadline malformed');
  }
  return value;
}
/** The observed child outcome as an internal note the next rebuilt context reads back. */
function waitNoteMessage(waited: ChildWaitObserved): UserMessage {
  if (waited.kind === 'steered') {
    const pending = waited.children.map((child) => child.runId);
    const rest = pending.length === 0 ? 'no child tasks' : pending.join(', ');
    const note = '[internal child wait] steered: new input arrived; still waiting on ' + rest + '.';
    return { role: 'user', content: note, timestamp: Date.now() };
  }
  // The stored result is already bounded; a longer one is read through its artifact ref.
  const seen = waited.children.map((child) => child.runId + ' ' + child.status + (child.result === null ? '' : ': ' + child.result + (child.resultRef === null ? '' : ' [full result: artifact ' + child.resultRef + ', read with output_read]')));
  const missing = waited.missing.length === 0 ? '' : ' Missing: ' + waited.missing.join(', ');
  const observed = seen.length === 0 ? 'no child tasks observed' : seen.join('; ');
  // A timeout leaves the children running (nothing is cancelled): say which, and what the model can do next.
  const running = waited.kind === 'timeout' ? waited.children.filter((child) => !isTerminal(child.status)).map((child) => child.runId) : [];
  const next = running.length === 0 ? '' : ' Still running: ' + running.join(', ') + '. Call child_wait again to keep waiting, child_message to send one more instruction, or child_cancel to stop one.';
  return { role: 'user', content: '[internal child wait] ' + waited.kind + ': ' + observed + '.' + missing + next, timestamp: Date.now() };
}
/** A child-wait note longer than this is kept whole as an output artifact; the note keeps its head and the reference. */
const WAIT_NOTE_MAX_CHARS = 8_000;
const WAIT_NOTE_HEAD_CHARS = 2_000;

async function boundedWaitNote(store: Store, scope: { ownerId: string; agentId: string; runId: string; stepId: string }, waited: ChildWaitObserved): Promise<UserMessage> {
  const message = waitNoteMessage(waited);
  const text = typeof message.content === 'string' ? message.content : '';
  if (text.length <= WAIT_NOTE_MAX_CHARS) return message;
  const captured = await captureOutputArtifact(store, { ...scope, tool: 'child_wait', text, redact: redactText });
  return { ...message, content: text.slice(0, WAIT_NOTE_HEAD_CHARS) + '\n' + artifactNotice(captured, 'child_wait') };
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
  if (suspend.reason === 'child') {
    const explicit = strictIds('suspend', Reflect.get(suspend, 'runIds'));
    const recorded = details === undefined ? undefined : strictIds('details', Reflect.get(details, 'runIds'));
    const waiting = details === undefined ? undefined : strictIds('details', Reflect.get(details, 'waiting'));
    const selected = explicit ?? recorded ?? waiting;
    const timeoutMs = strictTimeout('suspend', Reflect.get(suspend, 'timeoutMs'))
      ?? (details === undefined ? undefined : strictTimeout('details', Reflect.get(details, 'timeoutMs')));
    const deadline = strictUntil('suspend', Reflect.get(suspend, 'until'))
      ?? (details === undefined ? undefined : strictUntil('details', Reflect.get(details, 'until')));
    const waited = await runChildWait(ctx, services, runId, stepIndex, cancellation, {
      ...(selected === undefined ? {} : { runIds: selected }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(deadline === undefined ? {} : { until: deadline }),
    }, async () => {
      const drained = await drainAndAppend(ctx, services, input, cancellation, 'childwait:' + String(stepIndex));
      if (drained === CANCELLED) return 'cancelled';
      return drained;
    });
    if (waited.kind === 'cancelled') return 'stopped';
    const key = ctx.rand.uuidv4();
    await ctx.run('child-wait-outcome:' + String(stepIndex), async () => {
      const note = await boundedWaitNote(services.store, { ownerId: input.wakeEvents[0]?.ownerId ?? '', agentId: input.agentId, runId, stepId: 'child-wait-' + String(stepIndex) }, waited);
      await appendToTranscript(services.store, input.sessionKey, [note], key);
    });
    return 'resume';
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
