/** Raise a request the user answers: secure input and take-over suspend the run on it; a question only shows its card. */
import type { Request } from '@agent-desktop/public-contracts';
import type { Store, ToolContext, ToolResult } from '../../../contracts/index.js';
import { emitAgentStatus } from '../../../execution/agent-status.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { newId, nowIso } from '../util.js';

/** The request fields every user request shares; the caller supplies the kind-specific rest. */
export function userRequest(ctx: ToolContext, fields: Pick<Request, 'kind' | 'title' | 'summary' | 'payload'>): Request {
  return {
    id: newId('req'),
    status: 'pending',
    agentId: ctx.agentId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    createdAt: nowIso(),
    ...fields,
  };
}

/** Store the request with its chat item and events in one durable step; the card shows in the chat. */
export async function storeUserRequest(store: Store, ctx: ToolContext, request: Request): Promise<void> {
  const item = { id: newId('itm'), conversationId: ctx.conversationId, type: 'request' as const, requestId: request.id, at: nowIso() };
  await ctx.step('create_request', async () => {
    await store.put('requests', request);
    await store.put('items', item, { conversationId: ctx.conversationId });
    await store.emit({ type: 'request.created', request });
    await emitAgentStatus(store, request.agentId);
    await emitItemAdded(store, ctx.conversationId, item);
  });
}

/** Store the request, then suspend: the run resumes with the decision as the next user turn (run-input.ts). */
export async function raiseUserRequest(store: Store, ctx: ToolContext, request: Request, text: string): Promise<ToolResult> {
  await storeUserRequest(store, ctx, request);
  return { content: [{ type: 'text', text }], suspend: { reason: 'user', awakeableId: request.id } };
}
