/**
 * Recent chat history for a group mention (Discord, Slack). When the agent is @mentioned or replied to in a server channel or
 * thread, the messages just before it are fetched from the platform with the bot token and handed to the run as read-only context
 * on the wake payload. They are other people's text (untrusted) and are never stored as conversation items. Any failure means no
 * context, not a failed wake. Telegram's Bot API cannot read history, so Telegram groups get none.
 *
 * Only what the agent has not seen: the transcript is append-only and already holds every earlier wake and the agent's own replies,
 * so a later wake gets the messages after the newest one this conversation already stored as a wake item (every admitted
 * platform message is stored under `channelItemId(conversation, platform message id)`, so the fetched messages are matched
 * against the store, no extra state), without the agent's own lines. The first wake of a conversation gets the whole window.
 *
 * The platform calls live in @agent-desktop/channels; this file labels the normalized messages. The shared app posts every agent's
 * replies, so the platform author name is the agent's name (a webhook / app username) or the bare app name, never a person: lines
 * posted by our own app are labelled by the agent they were posted as, and the agent's own earlier replies read "you (Name)".
 */
import type { ChannelRow, Store } from '@agent-desktop/contracts';
import { HISTORY_FETCH_LIMIT, type ChannelMessage, type HistoryRequest } from '@agent-desktop/channels/types';
import type { AdapterResult } from '@agent-desktop/channels/abilities';
import type { ChannelIdentity } from '@agent-desktop/channels/identity';
import type { ChannelRegistry } from './registry.js';
import { readsChatHistory } from 'juno-agent/modules/channel-origin';
import { channelConversationId, channelItemId } from '../routes/channels.js';
import { docOwnerId } from '../routes/relationships.js';
import { openChannelRow } from './credentials.js';

const MAX_CHARS = 6000;
const MAX_LINE = 1000;
const NOT_SHOWN = '(earlier messages not shown)';

/** Oldest first, newest kept when the cap bites. `capped`: older lines were dropped to fit. */
function keepNewest(lines: string[], maxChars: number): string[] {
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').slice(0, MAX_LINE);
    if (size + line.length + 1 > maxChars) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  return kept;
}

function joinCapped(lines: string[]): { text: string; capped: boolean } | undefined {
  const kept = keepNewest(lines, MAX_CHARS);
  return kept.length === 0 ? undefined : { text: kept.join('\n'), capped: kept.length < lines.length };
}

/** Who "we" are in a chat: the shared bot's user id and webhooks, this agent's name and the other agents of the same install. */
export interface HistoryIdentity {
  botUserId?: string;
  webhookIds: ReadonlySet<string>;
  selfName: string;
  otherAgentNames: ReadonlySet<string>;
}

/**
 * One line per message. A message posted by our app (the bot user, or one of the install's webhooks) was posted as an agent, named
 * by its username: this agent reads "you (Name)", another agent of the install reads its name. A bot-user message that names no
 * known agent counts as this agent's when it is the install's only agent, else "another agent"; the bare bot name is never shown.
 * `own` marks this agent's own lines.
 */
function labelMessage(message: ChannelMessage, who: HistoryIdentity): { line: string; own: boolean } {
  const { author } = message;
  const ours = (who.botUserId !== undefined && author.id === who.botUserId) || (author.webhookId !== undefined && who.webhookIds.has(author.webhookId));
  if (!ours) return { line: author.name + ': ' + message.text, own: false };
  const self = who.selfName.slice(0, 80);
  const own = author.name === self || who.otherAgentNames.size === 0;
  const label = own ? 'you (' + who.selfName + ')' : who.otherAgentNames.has(author.name) ? author.name : 'another agent';
  return { line: label + ': ' + message.text, own };
}

export function labelHistory(messages: ChannelMessage[], who: HistoryIdentity): string[] {
  return messages.map((message) => labelMessage(message, who).line);
}

/** Every channel row of the install this one belongs to (this agent's own included). */
async function installRows(store: Store, channel: ChannelRow): Promise<ChannelRow[]> {
  if (channel.installationId === undefined) return [channel];
  const page = await store.list('channels', { where: { kind: channel.kind }, limit: 500 });
  return page.items.filter((row) => row.installationId === channel.installationId);
}

async function identityFor(store: Store, channel: ChannelRow, rows: ChannelRow[], opened: { channel: ChannelRow; installation?: { webhooks?: Record<string, { id: string }> } }): Promise<HistoryIdentity> {
  const agent = await store.get('agents', channel.agentId);
  const others = new Set<string>();
  for (const row of rows) {
    if (row.agentId === channel.agentId) continue;
    const other = await store.get('agents', row.agentId);
    if (other) others.add(other.name.slice(0, 80));
  }
  return {
    ...(opened.channel.botUserId === undefined ? {} : { botUserId: opened.channel.botUserId }),
    webhookIds: new Set(Object.values(opened.installation?.webhooks ?? {}).map((hook) => hook.id)),
    selfName: agent?.name ?? 'you',
    otherAgentNames: others,
  };
}

/** Discord role id to the agent it names: the handle the agent is mentioned by (the same one delivery turns "@Name" into a role tag from). */
function roleNames(rows: ChannelRow[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) if (row.roleId !== undefined && (row.handle ?? '') !== '') names.set(row.roleId, row.handle ?? '');
  return names;
}

/** Index of the newest fetched message this conversation already stored as a wake item (the agent has seen everything up to it), or -1. */
async function lastSeenIndex(store: Store, channel: ChannelRow, identity: ChannelIdentity, event:{ chatId: string; threadId: string; externalMessageId: string }, messages: ChannelMessage[]): Promise<number> {
  const ownerId = docOwnerId(channel);
  if (ownerId === undefined) return -1;
  const conversationId = channelConversationId(ownerId, channel.kind, channel.channelId, event.threadId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const external = identity.externalMessageKey(event.chatId, messages[i]?.id ?? '');
    if (external === event.externalMessageId || messages[i]?.id === '') continue;
    if (await store.get('items', channelItemId(conversationId, external))) return i;
  }
  return -1;
}

const EARLIER_MAX_CHARS = 20000;

/** A speaker as the wake labels one: a name anyone can change comes with the stable handle (or the end of the platform id) and whether the person is the owner. */
function speakerOf(message: ChannelMessage, channel: ChannelRow, who: HistoryIdentity): string {
  const ours = labelMessage(message, who);
  if ((who.botUserId !== undefined && message.author.id === who.botUserId) || (message.author.webhookId !== undefined && who.webhookIds.has(message.author.webhookId))) {
    return ours.own ? ours.line.slice(0, ours.line.indexOf(':')) : ours.line.slice(0, ours.line.indexOf(':')) + ' (another agent)';
  }
  const name = message.author.name.replace(/[\r\n<>:]/g, ' ').slice(0, 80);
  const id = message.author.handle !== undefined ? '@' + message.author.handle.replace(/\s/g, '') : message.author.id === '' ? '' : 'id …' + message.author.id.slice(-4);
  const role = channel.ownerExternalId !== undefined && message.author.id === channel.ownerExternalId ? 'your owner' : message.author.isBot ? 'a bot, not your owner' : 'not your owner';
  return name + ' (' + (id === '' ? '' : id + ', ') + role + ')';
}

/**
 * Earlier messages of one chat for the `channel_history` tool, labelled like the wake labels them (you / another agent / your owner /
 * not your owner), one line each "time · who: text", oldest first. Nothing is stored. The adapter says when the platform cannot.
 */
export async function readChatHistory(
  deps: { store: Store; channels: ChannelRegistry; channelFetch?: typeof fetch },
  channel: ChannelRow,
  request: HistoryRequest,
): Promise<AdapterResult<{ lines: string[]; capped: boolean }>> {
  const opened = await openChannelRow(deps.store, channel);
  if ('error' in opened) return { status: 'failed', error: opened.error };
  const rows = await installRows(deps.store, channel);
  const adapter = deps.channels.get(channel.kind)?.adapter;
  if (adapter === undefined) return { status: 'unsupported' };
  const found = await adapter.abilities.history(deps.channelFetch ?? fetch, adapter.identity.authOf(opened.channel), { ...request, roleNames: roleNames(rows) });
  if (found.status !== 'ok') return found;
  const who = await identityFor(deps.store, channel, rows, opened);
  const lines = found.value.map((message) => {
    const at = Number.isNaN(Date.parse(message.at)) ? 'unknown time' : new Date(message.at).toISOString().slice(0, 19) + 'Z';
    const text = message.text.replace(/\s+/g, ' ').replace(/<(\/?)untrusted/gi, '‹$1untrusted');
    return at + ' · ' + speakerOf(message, channel, who) + ': ' + text;
  });
  const kept = keepNewest(lines, EARLIER_MAX_CHARS);
  return { status: 'ok', value: { lines: kept, capped: kept.length < lines.length } };
}

/**
 * The messages before a group mention, as read-only context for its wake. Only a platform whose registration says `groupHistory`
 * brings them (Discord, Slack), and it reads them through its history ability; the rest see the mention alone, as before.
 */
export async function fetchGroupHistory(
  deps: { store: Store; channels: ChannelRegistry; channelFetch?: typeof fetch },
  channel: ChannelRow,
  event: { chatId: string; threadId: string; externalMessageId?: string },
): Promise<string | undefined> {
  const triggerId = event.externalMessageId;
  const platform = deps.channels.get(channel.kind);
  if (platform?.groupHistory !== true || triggerId === undefined) return undefined;
  // The owner's switch (permission tier `readHistory`): off means the messages before a mention are not read either.
  if (!readsChatHistory(await deps.store.get('agents', channel.agentId))) return undefined;
  const opened = await openChannelRow(deps.store, channel);
  if ('error' in opened || opened.channel.botToken === undefined) return undefined;
  const fetchFn = deps.channelFetch ?? fetch;
  const rows = await installRows(deps.store, channel);
  const { adapter } = platform;
  const found = await adapter.abilities.history(fetchFn, adapter.identity.authOf(opened.channel), { chatId: event.chatId, threadId: event.threadId, beforeId: triggerId, roleNames: roleNames(rows) });
  if (found.status !== 'ok') return undefined;
  const messages = found.value;
  const seen = await lastSeenIndex(deps.store, channel, adapter.identity, { chatId: event.chatId, threadId: event.threadId, externalMessageId: triggerId }, messages);
  const who = await identityFor(deps.store, channel, rows, opened);
  const fresh = seen === -1 ? messages : messages.slice(seen + 1);
  // Without an earlier wake there is no transcript to repeat, so the window stays as it was fetched; with one, the agent's own lines are in it already.
  const lines = fresh.map((message) => labelMessage(message, who)).filter((labelled) => seen === -1 || !labelled.own).map((labelled) => labelled.line);
  const joined = joinCapped(lines);
  if (joined === undefined) return undefined;
  const olderExist = joined.capped || (seen === -1 && messages.length >= HISTORY_FETCH_LIMIT);
  return olderExist ? NOT_SHOWN + '\n' + joined.text : joined.text;
}
