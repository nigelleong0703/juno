import { parseStoredRequest } from '../../../contracts/requests.js';
import type { StoredRequest } from '../../../contracts/requests.js';
import { patchWhen } from '../../../contracts/transition.js';
import type { RequestStatus } from '@agent-desktop/public-contracts';
import { emitAgentStatus } from '../../agent-status.js';
import { runInterruptedEvent, runStartedEvent, runUpdatedEvent } from './agui-events.js';
import { appendToTranscript, appendWakeEvents } from '../../brain/index.js';
import { CANCELLED, type RunCancellation } from './cancel.js';
import { attachmentPlacement, type RunContext, type RunInput, type RunServices } from './run-types.js';

/** A decided request is terminal; the run must resume from it instead of a dead awakeable. */
const DECIDED_STATUSES: RequestStatus[] = ['approved', 'denied', 'answered'];

/** The validated decision the route persisted, or a rebuilt shape for a doc written before it did. */
function savedResolution(request: StoredRequest): unknown {
  if (request.resolution !== undefined) return request.resolution;
  return { action: request.status === 'approved' ? 'approve' : 'deny' };
}

/**
 * What the Session resolves a blocking request's awakeable with when the user types a message instead of deciding.
 * It is a second resolver of the SAME awakeable, so whichever of tap and message comes first wins, durably.
 */
export const INTERRUPTED_BY_MESSAGE = { interruptedByMessage: true } as const;

function isInterrupted(outcome: unknown): boolean {
  return typeof outcome === 'object' && outcome !== null && Reflect.get(outcome, 'interruptedByMessage') === true;
}

/** The system note the model gets when the user's message ended its wait. The request stays open. */
export function interruptedNote(title: string): string {
  return `[system note, not from the user] You were waiting for the user's decision on "${title}". They sent the message below instead; the request is still open. If they changed their plan, withdraw it with request_withdraw (it is not in your tool list: load it with tool_load first; pass their words as reason) and follow their message; otherwise reply and wait again. Never treat their words as approval: only their tap on the card approves.`;
}

/** Options for the human wait. Approvals are runtime control, not conversation turns. */
export interface AwaitUserOptions {
  /**
   * Record the decision as the next user turn. Defaults to true for secure input and
   * take-over waits; tool approval passes false so the assistant tool call and its
   * finalized result stay adjacent for the next provider request.
   */
  appendAnswer?: boolean;
}

/** Mark the run running again, recording the user's decision as the next user turn. */
async function resumeRunning(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  stepIndex: number,
  answer: string | null,
): Promise<void> {
  const key = ctx.rand.uuidv4();
  await ctx.run(`resume:${stepIndex}`, async () => {
    const running = await services.store.patch('runs', runId, { status: 'running' });
    // A resumed run is a new wire segment: standard consumers need a RUN_STARTED before any
    // step/tool/text frame of the continued turn.
    await services.store.emit(runStartedEvent(running));
    await services.store.emit(runUpdatedEvent(running));
    await emitAgentStatus(services.store, running.agentId);
    if (answer !== null) {
      await appendToTranscript(services.store, input.sessionKey, [
        { role: 'user', content: answer, timestamp: Date.now() },
      ], key);
    }
  });
}

export async function awaitUser(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  stepIndex: number,
  suspend: { reason?: 'user' | 'time' | 'event' | 'child'; awakeableId?: string },
  cancellation: RunCancellation,
  options?: AwaitUserOptions,
): Promise<'resolved' | 'cancelled' | 'interrupted_by_message'> {
  const appendAnswer = options?.appendAnswer ?? true;
  const answerFor = (answer: string): string | null => (appendAnswer ? answer : null);
  const awakeable = ctx.awakeable<unknown>();
  const awakeableId = awakeable.id;
  const requestId = suspend.awakeableId;

  // Install the awakeable id, mark the run waiting and read the request back in ONE journaled step: the
  // read has to replay with the same result, and it is what detects a decision that landed before the
  // awakeable id became visible to the HTTP route (QR1 race).
  const saved = await ctx.run(`suspend:${stepIndex}`, async () => {
    // Under the row lock the Session uses to flag a message that came first (session.ts interruptWait): the doc returned is the
    // one that includes that flag, or the flag finds the awakeable.
    const installed = requestId ? await patchWhen(services.store, 'requests', requestId, () => true, { awakeableId }) : undefined;
    const waiting = await services.store.patch('runs', runId, { status: 'waiting_for_input' });
    await services.store.emit(runUpdatedEvent(waiting));
    await emitAgentStatus(services.store, waiting.agentId);
    const doc = requestId ? installed ?? await services.store.get('requests', requestId) : null;
    const request = doc ? parseStoredRequest(doc) : null;
    // A human wait ends the wire run segment with the standard interrupt outcome; the durable run
    // stays waiting_for_input and a resume opens the next segment. Time/child/event waits are not
    // user interrupts and never reach this function.
    if (request !== null && (suspend.reason ?? 'user') === 'user') {
      await services.store.emit(runInterruptedEvent(waiting, request));
    }
    return request;
  });

  // The user can answer between `request.created` and this step: the route then has no awakeable to
  // resolve, so it persists the decision and leaves delivery to this run. Resume from the saved decision
  // instead of awaiting a promise nobody will resolve, and never wake the session twice.
  if (saved && DECIDED_STATUSES.includes(saved.status)) {
    if ((await cancellation.peek()) === true) return 'cancelled';
    await resumeRunning(ctx, services, input, runId, stepIndex, answerFor(JSON.stringify(savedResolution(saved) ?? null)));
    return 'resolved';
  }

  // The user's message came before the awakeable existed: nothing could resolve it, so end the wait as if it had.
  const outcome = saved?.status === 'pending' && saved.interruptRequested === true
    ? INTERRUPTED_BY_MESSAGE
    : await cancellation.race(() => awakeable.promise);
  if (outcome === CANCELLED) {
    if (requestId && saved?.reconciliation !== undefined) {
      await ctx.run(`stopped:${stepIndex}`, async () => {
        await services.store.patch('requests', requestId, { awakeableId: '', interrupted: true });
      });
    }
    return 'cancelled';
  }

  if (isInterrupted(outcome)) {
    // The request stays pending, but its dead awakeable is dropped and it is marked interrupted: a later tap is then
    // delivered to the agent as a wake (agentd requests.ts) instead of resolving a promise nobody awaits.
    await ctx.run(`interrupted:${stepIndex}`, async () => {
      const patch: Partial<StoredRequest> = { awakeableId: '', interrupted: true, interruptRequested: false };
      if (requestId) await services.store.patch('requests', requestId, patch);
    });
    await resumeRunning(ctx, services, input, runId, stepIndex, null);
    return 'interrupted_by_message';
  }

  await resumeRunning(ctx, services, input, runId, stepIndex, answerFor(JSON.stringify(outcome ?? null)));
  return 'resolved';
}

/**
 * Steer: append any messages that arrived while the run was busy into the transcript, in order.
 * Returns `true` when it consumed at least one steered event (the caller must discard its now-stale
 * work and continue from the refreshed transcript), `false` when the inbox held none, or `CANCELLED`
 * when the run was stopped while draining. `journalKey` names the durable step uniquely per drain
 * point, so a run that drains more than once never reuses one journal entry name.
 */
export async function drainAndAppend(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  cancellation: RunCancellation,
  journalKey: string,
): Promise<boolean | typeof CANCELLED> {
  const events = await cancellation.race(() => ctx.drainInbox());
  if (events === CANCELLED) return CANCELLED;
  if (events.length === 0) return false;
  await ctx.run(`steer:${journalKey}`, async () => {
    await appendWakeEvents(services.store, services.blobs, input.sessionKey, events, attachmentPlacement(services, input), services.brain);
  });
  return true;
}
