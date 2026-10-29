/**
 * Where a channel reply goes. The owner's private chat with an agent on each platform is its own conversation (kind direct, with
 * `channel` meta), like a group room; the app's main direct conversation is app-only. A run's agent messages carry `replyTo` (the
 * chat of the message that woke the run: a platform message, or an app message sent inside a channel conversation) and delivery
 * sends to exactly that, else to the chat a channel conversation is pinned to.
 */
import type { Store } from '@agent-desktop/contracts';
import type { ChannelOrigin, Conversation } from '@agent-desktop/public-contracts';
import { channelMetaOf } from '../routes/channels.js';
import { parseButtonToken } from '@agent-desktop/channels/render';

/** The origin pinned on a channel conversation (owner's private chat, group chat, stranger's private chat), if it is one. */
export function conversationOrigin(conv: Conversation): ChannelOrigin | undefined {
  const meta = channelMetaOf(conv);
  if (meta === undefined) return undefined;
  const chatType = conv.kind === 'room' ? 'group' : 'private';
  return { kind: meta.kind, channelId: meta.channelId, chatId: meta.chatId, threadId: meta.threadId, chatType };
}

/**
 * A group with outside members (Slack Connect, a Feishu external group) speaks only when addressed: a reply that answers no platform
 * message (`replyTo` absent: a routine, a monitor, a post to the room) is held back. Replies to a mention or a reply go through.
 */
export function holdsQuietReply(conv: Conversation | null, item: { replyTo?: ChannelOrigin }): boolean {
  return conv !== null && (conv as { externalGroup?: unknown }).externalGroup === true && item.replyTo === undefined;
}

/** The platform chat an agent message is delivered to: the run's origin on the item, else the chat a channel-only conversation is pinned to. */
export function originOfItem(item: { replyTo?: ChannelOrigin }, conv: Conversation): ChannelOrigin | undefined {
  return item.replyTo ?? conversationOrigin(conv);
}

/**
 * The platform chat a question / approval goes to. Requests do not record a wake, so the origin is that of the user message the
 * run answered: the latest user message in the conversation at or before the request (or the pinned chat of a channel-only conversation).
 */
export async function originOfRequest(store: Store, request: { conversationId?: string; createdAt: string }): Promise<{ origin: ChannelOrigin; conv: Conversation } | undefined> {
  if (request.conversationId === undefined) return undefined;
  const conv = await store.get('conversations', request.conversationId);
  if (conv === null) return undefined;
  const pinned = conversationOrigin(conv);
  if (pinned !== undefined) return { origin: pinned, conv };
  const recent = await store.list('items', { where: { conversationId: conv.id }, orderBy: 'at', order: 'desc', limit: 30 });
  const asked = recent.items.find((item) => item.type === 'user_message' && item.at <= request.createdAt);
  return asked?.type === 'user_message' && asked.source !== undefined ? { origin: asked.source, conv } : undefined;
}

/** The connected channel a button token's message was delivered to (shared apps serve many agents on one endpoint). */
export async function channelIdOfToken(store: Store, token: string): Promise<string | undefined> {
  const parsed = parseButtonToken(token);
  if (parsed === undefined) return undefined;
  if (parsed.kind === 'item') {
    const item = await store.get('items', parsed.id);
    const conv = item?.type === 'agent_message' ? await store.get('conversations', item.conversationId) : null;
    return item?.type === 'agent_message' && conv !== null ? originOfItem(item, conv)?.channelId : undefined;
  }
  const request = await store.get('requests', parsed.id);
  return request === null ? undefined : (await originOfRequest(store, request))?.origin.channelId;
}
