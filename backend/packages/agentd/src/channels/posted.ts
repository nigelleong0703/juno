/**
 * The agent's own posts, remembered by their platform id (BACKEND 6.8): delivery writes a receipt for each message it posts, so a later
 * reply in a thread under it (Slack: the thread's ts is that post's ts) is known to answer the agent even without a mention.
 */
import { eventReceiptId } from 'juno-agent/execution/harness/services/event-receipts';

export const postedReceiptId = (ownerId: string, agentId: string, channelRowId: string, chatId: string, externalId: string): string =>
  eventReceiptId({ ownerId, agentId, conversationId: 'posts:' + channelRowId }, 'channel', 'posted', chatId + ':' + externalId);

/** The receipt of a message the agent posted: platform chat + platform message id, scoped to the channel row. */
export function postedReceipt(ownerId: string, agentId: string, channelRowId: string, chatId: string, externalId: string, now: string) {
  return {
    id: postedReceiptId(ownerId, agentId, channelRowId, chatId, externalId),
    agentId, conversationId: 'posts:' + channelRowId, runId: 'posts', source: 'channel', type: 'posted', eventId: chatId + ':' + externalId, consumedAt: now, createdAt: now,
  };
}
