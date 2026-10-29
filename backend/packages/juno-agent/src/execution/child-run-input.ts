/**
 * Child run input mapping kept out of enqueuer.ts so it stays within the file-size rule: a reserved
 * child is woken by a real `child_task` event, never a peer message. Request expiry is the one
 * qualified paged sweep (all pages, emits request.resolved, preserves approved/denied) shared by the
 * run workflow, the Stop route and the enqueuer.
 */
import { parseStoredRequest, toPublicRequest } from '../contracts/requests.js';
import { patchWhen, type ChildRunStart, type Store, type WakeEvent } from '../contracts/index.js';

export function childRunInput(input: ChildRunStart): { agentId: string; conversationId: string; sessionKey: string; wakeEvents: WakeEvent[] } {
  const wake: WakeEvent = {
    id: 'wake_child_' + input.runId,
    ownerId: input.ownerId,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    conversationId: input.conversationId,
    kind: 'child_task',
    origin: { type: 'agent', id: input.parentRunId, label: 'child task' },
    trusted: false,
    priority: 'background',
    payload: { parentRunId: input.parentRunId, childRunId: input.runId, planId: input.planId, prompt: input.prompt, depth: input.depth },
    hop: { chainId: input.parentRunId, depth: input.depth },
    at: new Date().toISOString(),
    status: 'accepted',
  };
  return { agentId: input.agentId, conversationId: input.conversationId, sessionKey: input.sessionKey, wakeEvents: [wake] };
}
const REQUEST_PAGE = 500;
/** `keepInterrupted`: a run that finished normally leaves its question cards and the cards its wait was interrupted on open (the user may still answer them). */
export async function expirePendingRequests(store: Store, runId: string, options?: { keepInterrupted?: boolean }): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.list('requests', { limit: REQUEST_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const request of page.items) {
      if (request.runId !== runId || request.status !== 'pending') continue;
      // A question never blocks its run, so it outlives a normal finish: the answer arrives later as the user's next message.
      // A question never blocks its run, so it outlives a normal finish: the answer arrives later as the user's next message.
      if (options?.keepInterrupted === true && (request.kind === 'question' || parseStoredRequest(request).interrupted === true)) continue;
      // Another process may have decided it since the page was read: only a still-pending row is closed here.
      const expired = await patchWhen(store, 'requests', request.id, (current) => current.status === 'pending', { status: 'expired', resolvedAt: new Date().toISOString() });
      if (expired === undefined) continue;
      await store.emit({ type: 'request.resolved', request: toPublicRequest(expired) });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}
