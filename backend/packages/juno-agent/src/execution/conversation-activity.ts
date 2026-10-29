import type { Store } from '../contracts/index.js';
import type { Conversation, Item } from '@agent-desktop/public-contracts';
import { assistantMessageEvents } from './harness/services/agui-events.js';

/** The newest items looked at per conversation; enough to count up to UNREAD_CAP unread items. */
const ACTIVITY_WINDOW = 100;
/** The UI shows 99+ at this count. */
const UNREAD_CAP = 99;

/**
 * Items that make a chat unread: what the agent says or asks of the user (`agent_message`, `request`,
 * `artifact`, and the `role_suggestion` card). The user's own message is never unread; `run`, `plan`,
 * `routine` and `handoff` rows are progress noise, and an `info` notice is a log line. Warning and
 * error notices (e.g. the routine auto-pause) do count.
 */
export function countsAsUnread(item: Item): boolean {
  switch (item.type) {
    case 'agent_message':
    case 'request':
    case 'artifact':
    case 'role_suggestion':
    case 'feed_ref':
      return true;
    case 'system':
      return item.level !== 'info';
    default:
      return false;
  }
}

const PREVIEW_MAX = 140;

/** One plain line from markdown: drop code fences, images, link targets and emphasis marks, collapse whitespace. */
export function previewText(markdown: string): string {
  const plain = markdown
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > PREVIEW_MAX ? `${plain.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : plain;
}

/** A reply starts with the quoted message as "> " lines; the preview is the reply, not the quote. */
function withoutLeadingQuote(text: string): string {
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length && /^\s{0,3}>/.test(lines[start] ?? '')) start += 1;
  const rest = lines.slice(start).join('\n').trim();
  return start > 0 && rest !== '' ? rest : text;
}

/** The preview of a user/agent message; undefined for every other item type (they never change it). */
function messagePreview(item: Item): Conversation['lastMessage'] {
  if (item.type === 'user_message') {
    const text = previewText(withoutLeadingQuote(item.text)) || (item.attachments[0] ? `📎 ${item.attachments[0].name}` : '');
    return text === '' ? undefined : { text, authorKind: 'user', at: item.at };
  }
  if (item.type === 'agent_message') {
    const text = previewText(withoutLeadingQuote(item.markdown));
    return text === '' ? undefined : { text, authorKind: 'agent', agentId: item.agentId, at: item.at };
  }
  return undefined;
}

/** Items that move `lastItemAt`: everything that is unread-worthy plus the user's own messages. */
function isActivity(item: Item): boolean {
  return item.type === 'user_message' || countsAsUnread(item);
}

/**
 * Last activity and unread count, computed from the conversation's newest items on every read and
 * never stored (like agentStatus), so replays and restarts cannot drift or double count.
 * Unread = unread-worthy items newer than `lastReadAt` (a chat never marked read counts them all),
 * capped at 99.
 */
export async function conversationActivity(store: Store, conversation: Conversation): Promise<Pick<Conversation, 'lastItemAt' | 'unreadCount' | 'lastMessage' | 'lastMessagePreview' | 'channel'>> {
  const newest = await store.list('items', {
    where: { conversationId: conversation.id },
    orderBy: 'at',
    order: 'desc',
    limit: ACTIVITY_WINDOW,
  });
  const readAt = conversation.lastReadAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(conversation.lastReadAt);
  let lastItemAt: string | undefined;
  let unreadCount = 0;
  let lastMessage: Conversation['lastMessage'];
  for (const item of newest.items) {
    if (isActivity(item) && lastItemAt === undefined) lastItemAt = item.at;
    if (lastMessage === undefined) lastMessage = messagePreview(item);
    if (countsAsUnread(item) && Date.parse(item.at) > readAt && unreadCount < UNREAD_CAP) unreadCount += 1;
  }
  const base = { lastItemAt: lastItemAt ?? conversation.createdAt, unreadCount, channel: channelOrigin(conversation) };
  // Derived like the rest: a stored value (older rows) is ignored, and a chat with no message in the window has none.
  return lastMessage === undefined
    ? { ...base, lastMessage: undefined, lastMessagePreview: undefined }
    : { ...base, lastMessage, lastMessagePreview: lastMessage.text };
}

/** The platform origin of a channel chat (stored with routing detail the client never sees), or undefined for an in-app chat. */
function channelOrigin(conversation: Conversation): Conversation['channel'] {
  const stored: unknown = Reflect.get(conversation, 'channel');
  if (typeof stored !== 'object' || stored === null) return undefined;
  const kind: unknown = Reflect.get(stored, 'kind');
  const channelId: unknown = Reflect.get(stored, 'channelId');
  return typeof kind === 'string' && typeof channelId === 'string' ? { kind, channelId } : undefined;
}

/** A conversation row with the derived fields overlaid, as the API returns it (stored values are ignored). */
export async function withLiveActivity(store: Store, conversation: Conversation): Promise<Conversation> {
  return { ...conversation, ...(await conversationActivity(store, conversation)) };
}

/** Emit the recomputed row; it is a full snapshot, so emitting twice (or replaying it) is harmless. */
export async function emitConversationActivity(store: Store, conversationId: string): Promise<void> {
  const conversation = await store.get('conversations', conversationId);
  if (conversation === null) return;
  await store.emit({ type: 'conversation.updated', conversation: await withLiveActivity(store, conversation) });
}

/** `item.added`, plus the chat's new unread count and last activity when the item changes them. */
export async function emitItemAdded(store: Store, conversationId: string, item: Item): Promise<void> {
  await store.emit({ type: 'item.added', conversationId, item });
  // The authoritative reply is also standard AG-UI text, under its own item id, so a standard
  // consumer rebuilds the conversation without reading `item.added`. Provisional previews stay
  // separate (`preview_<attemptId>`), and a rewritten streamed bubble re-announces its final text.
  if (item.type === 'agent_message' && item.markdown !== '') {
    for (const event of assistantMessageEvents(item)) await store.emit(event);
  }
  if (isActivity(item)) await emitConversationActivity(store, conversationId);
}
