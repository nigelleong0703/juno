/**
 * Reading a group's earlier messages when the agent joins it (BACKEND 6.8). Before its first reply the agent should know the group, so
 * the platform's history is read (bounded: the last 30 days or 500 messages, whichever is smaller), stored as observed items in the
 * channel's own conversation, and one chat digest run over them writes the first team picture (people, roles, open loops, norms,
 * rhythm). It runs in the background: a mention that arrives before the digest finished is answered with what exists.
 *
 * Where the platform cannot read earlier messages (Telegram's Bot API; a Feishu app without the group-message permission) the setting
 * says `unavailable` and the agent starts from what is said from now on. The owner can turn reading history off for an agent
 * (permission tier `readHistory`); that applies here too.
 */
import { createLogger } from '@agent-desktop/log';
import { channelRowId, type ChannelRow, type GroupBackfill } from '@agent-desktop/contracts';
import { sessionKey, wakeEventSchema } from '@agent-desktop/contracts';
import type { Item } from '@agent-desktop/public-contracts';
import { emitItemAdded } from 'juno-agent/execution/conversation-activity';
import { readsChatHistory } from 'juno-agent/modules/channel-origin';
import { channelAuthorId } from './author.js';
import { openChannelRow } from './credentials.js';
import { channelConversationId, channelItemId, getOrCreateConversation, speakerFor, type AdmitDeps } from '../routes/channels.js';

const log = createLogger({ service: 'agentd' });

export const BACKFILL_MAX_MESSAGES = 500;
export const BACKFILL_MAX_DAYS = 30;
const PAGE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

async function setBackfill(deps: Pick<AdmitDeps, 'store'>, rowId: string, chatId: string, backfill: GroupBackfill): Promise<void> {
  const row = await deps.store.get('channels', rowId);
  if (row === null) return;
  await deps.store.patch('channels', rowId, { groups: { ...row.groups, [chatId]: { ...row.groups?.[chatId], backfill } }, updatedAt: new Date().toISOString() });
}

/** Marks the chat's backfill as started; false when it was started (or done) before, so a chat is read once however many messages arrive at once. */
export async function claimBackfill(deps: Pick<AdmitDeps, 'store'>, channel: ChannelRow, chatId: string): Promise<boolean> {
  const row = await deps.store.get('channels', channel.id);
  if (row === null || row.groups?.[chatId]?.backfill !== undefined) return false;
  await setBackfill(deps, channel.id, chatId, { status: 'running', at: new Date().toISOString() });
  return true;
}

/** Read the chat's earlier messages and have the digest write its first picture. Never throws; the outcome is on the channel row. */
export async function backfillGroup(deps: AdmitDeps, ownerId: string, channel: ChannelRow, chat: { chatId: string; chatType: 'group' }): Promise<void> {
  const done = (backfill: GroupBackfill): Promise<void> => setBackfill(deps, channel.id, chat.chatId, backfill);
  try {
    const platform = deps.channels.get(channel.kind);
    const agent = await deps.store.get('agents', channel.agentId);
    const opened = await openChannelRow(deps.store, channel);
    if (platform === undefined || 'error' in opened || !readsChatHistory(agent)) return await done({ status: 'unavailable', at: new Date().toISOString() });
    const { adapter } = platform;
    const fetchFn = deps.channelFetch ?? fetch;
    const auth = adapter.identity.authOf(opened.channel);
    const oldest = Date.now() - BACKFILL_MAX_DAYS * DAY_MS;
    const found: Array<{ id: string; at: string; text: string; authorId: string; name: string }> = [];
    let beforeAt: string | undefined;
    while (found.length < BACKFILL_MAX_MESSAGES) {
      const page = await adapter.abilities.history(fetchFn, auth, { chatId: chat.chatId, threadId: chat.chatId, limit: PAGE, ...(beforeAt === undefined ? {} : { beforeAt }) });
      if (page.status !== 'ok') return await done(found.length === 0 ? { status: page.status === 'failed' ? 'failed' : 'unavailable', at: new Date().toISOString() } : { status: 'done', count: found.length, at: new Date().toISOString() });
      const fresh = page.value.filter((message) => !message.author.isBot && message.text.trim() !== '' && Date.parse(message.at) >= oldest);
      found.push(...fresh.map((message) => ({ id: message.id, at: message.at, text: message.text, authorId: message.author.id, name: message.author.name })));
      const first = page.value[0];
      // Stop at the start of the chat, at the age cap, or when a page brought nothing older.
      if (page.value.length < PAGE || first === undefined || Date.parse(first.at) < oldest || first.at === beforeAt) break;
      beforeAt = first.at;
    }
    const messages = found.sort((a, b) => a.at.localeCompare(b.at)).slice(-BACKFILL_MAX_MESSAGES);
    const meta = { kind: channel.kind, channelId: channel.channelId, threadId: chat.chatId, chatId: chat.chatId };
    const now = new Date().toISOString();
    const conv = await getOrCreateConversation(deps, ownerId, channel.agentId, channelConversationId(ownerId, channel.kind, channel.channelId, chat.chatId), { chatType: 'group', chatId: chat.chatId, text: '' }, meta, channel, now, undefined, true);
    for (const message of messages) {
      const role = speakerFor(channel.ownerExternalId, message.authorId);
      const item: Extract<Item, { type: 'user_message' }> = {
        id: channelItemId(conv.id, adapter.identity.externalMessageKey(chat.chatId, message.id)),
        conversationId: conv.id,
        type: 'user_message',
        at: message.at,
        authorId: channelAuthorId(ownerId, { role, kind: channel.kind, externalId: message.authorId === '' ? 'unknown' : message.authorId }),
        text: message.text,
        attachments: [],
        mentions: [],
        ...(message.authorId === '' ? {} : { channelSender: { kind: channel.kind, externalId: message.authorId, name: message.name, role } }),
        source: { ...meta, chatType: 'group' },
        observed: true,
      };
      if ((await deps.store.get('items', item.id)) === null) {
        await deps.store.tx(async (store) => {
          await store.put('items', item, { conversationId: conv.id });
          await emitItemAdded(store, conv.id, item);
        });
      }
    }
    await done({ status: 'done', count: messages.length, at: new Date().toISOString() });
    if (messages.length === 0) return;
    // One digest over everything read: the observed wake that starts it at once (never a run of the agent).
    const wake = wakeEventSchema.parse({
      id: 'wk-backfill-' + conv.id,
      ownerId,
      agentId: channel.agentId,
      sessionKey: sessionKey(channel.agentId, conv.id),
      conversationId: conv.id,
      kind: 'observed',
      origin: { type: 'user' },
      trusted: false,
      priority: 'background',
      payload: { text: '', backfill: true, channelKind: channel.kind, channelId: channel.channelId, chatId: chat.chatId, threadId: chat.chatId },
      at: new Date().toISOString(),
      status: 'accepted',
    });
    await deps.enqueuer.enqueue(wake);
  } catch (err) {
    log.warn({ err, channel: channelRowId(channel.kind, channel.channelId), chatId: chat.chatId }, 'reading the earlier messages of a group failed');
    await done({ status: 'failed', at: new Date().toISOString() }).catch(() => undefined);
  }
}
