import type { Store, WakeEvent } from '../../../contracts/index.js';
import type { QueuedEvent } from '../logic/busy.js';
import { isPrivateConversation, PRIVATE_IDLE_WINDOW_MS, privateReplyDelayMs } from '../logic/idle.js';
import type { SessionIo, SessionState } from './session-state.js';

/** True when this wake is a user message in a private (1:1/peer) chat that can coalesce. */
export async function isPrivateReplyBurst(store: Store, event: WakeEvent): Promise<boolean> {
  // No idle window configured: start the run at once, no durable timer is scheduled.
  if (PRIVATE_IDLE_WINDOW_MS <= 0) return false;
  if (event.kind !== 'user_message' || event.origin.type !== 'user') return false;
  const conv = await store.get('conversations', event.conversationId);
  return isPrivateConversation(conv?.kind);
}

/**
 * Arm a fresh private idle window; the newest token wins and supersedes the earlier timer. The run this window
 * will start is named here (once per window), so every message that joins the window reports the same run id.
 */
export function armFlush(io: SessionIo, state: SessionState, token: string, now: number, delayMs: number = privateReplyDelayMs(token)): void {
  state.pendingFlushToken = token;
  state.pendingSince ??= now;
  state.pendingRunId ??= io.newRunId();
  io.writeState(state);
  io.scheduleFlush(token, delayMs);
}

/** Start the next run from an admitted batch and move the session into its running state. */
export function beginRun(
  io: SessionIo,
  state: SessionState,
  batch: { batch: QueuedEvent[]; rest: QueuedEvent[] },
  now: number,
): void {
  const first = batch.batch[0];
  if (!first) return;
  // A run started from a private window takes the id that window already reported to its messages.
  const runId = state.pendingRunId ?? io.newRunId();
  state.pendingRunId = null;
  io.startRun(runId, {
    agentId: first.event.agentId,
    conversationId: first.event.conversationId,
    sessionKey: first.event.sessionKey,
    wakeEvents: batch.batch.map(q => q.event),
  });
  state.activeRunId = runId;
  state.pendingSince = null;
  state.recentStarts = [...state.recentStarts, now].slice(-10);
  state.inbox = batch.rest;
  state.status = 'running';
}
