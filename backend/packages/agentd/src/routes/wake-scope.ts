import type { Store } from '@agent-desktop/contracts';
import type { Conversation } from '@agent-desktop/public-contracts';
import { isConversationVisible, relationshipError, type RelationshipError } from './relationships.js';

/** Resolve an existing, visible chat; explicit targets never silently fall back. */
export async function resolveWakeConversation(
  store: Store, ownerId: string, agentId: string, requestedId?: string,
): Promise<Conversation | RelationshipError> {
  if (requestedId !== undefined) {
    const chat = await store.get('conversations', requestedId);
    if (!chat) return relationshipError(400, 'WAKE_CHAT_NOT_FOUND', 'Wake conversation not found');
    if (!isConversationVisible(chat, ownerId)) return relationshipError(403, 'WAKE_CHAT_FORBIDDEN', 'Wake conversation is not yours');
    if (!chat.agentIds.includes(agentId)) {
      return relationshipError(400, 'WAKE_CHAT_MISMATCH', 'Wake conversation must include the agent');
    }
    return chat;
  }
  let cursor: string | undefined;
  do {
    const page = await store.list('conversations', { limit: 200, cursor });
    const chat = page.items.find((row) => row.kind === 'direct'
      && row.agentIds.includes(agentId) && isConversationVisible(row, ownerId));
    if (chat) return chat;
    cursor = page.nextCursor;
  } while (cursor);
  return relationshipError(400, 'WAKE_CHAT_NOT_FOUND', 'No direct conversation exists for this agent');
}
