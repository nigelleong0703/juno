/**
 * Platform channel ingress, agentd side (CH1): one accepted platform event becomes exactly one wake.
 *
 * POST /v1/channels/:kind/:channelId/events runs behind the service bearer (the api gateway already
 * verified the platform secret and forwards as the channel's owner). The handler resolves the channel
 * row to its agent, derives the conversation id deterministically from the platform identity
 * (owner + kind + channel + thread) so a redelivered webhook or a restart can never fork one thread
 * into two conversations, admits the platform message as a user_message item, and enqueues one wake:
 * `user_message` for a private chat, `room_mention` for a group. Who is speaking is decided here at
 * ingress (owner vs stranger, from the bound ownerExternalId) and written into the wake payload as
 * `speakerRole` with `trusted: true`; it is never left to the model.
 * Only the owner's own words are trusted instructions (`trusted` is true exactly when the
 * speaker is the owner); a stranger's message is admitted and wakes the agent but can never
 * satisfy the trusted-user-instruction path. The speaker decision itself stays at ingress.
 */
import { type Context, type Hono } from 'hono';
import { createLogger } from '@agent-desktop/log';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { channelRowId, sessionKey, wakeEventSchema, type ChannelRow } from '@agent-desktop/contracts';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import type { ChannelOrigin, Conversation, Item } from '@agent-desktop/public-contracts';
import { emitItemAdded } from 'juno-agent/execution/conversation-activity';
import { peerSenderPayload } from 'juno-agent/modules/tools/tools/relationPolicy';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { docOwnerId, isAgentVisible } from './relationships.js';
import { isStartCommand } from '../channels/bind.js';
import { channelAuthorId } from '../channels/author.js';
import { holdForOwnerConfirmation } from '../channels/owner-claim.js';
import { addressesAgent, recordIngressSender } from '../channels/people.js';
import { unavailableMessage } from '../channels/registry.js';
import { chatTitleFor, ownerChatTitle } from '../channels/titles.js';
import { fetchGroupHistory } from '../channels/history.js';
import { startWorking } from '../channels/working.js';
import { classifyMentions } from '../channels/mentions.js';
import { storeInboundFiles } from '../channels/files.js';

export type IncomingChannelEvent = z.infer<typeof channelEventSchema>;

const log = createLogger({ service: 'agentd' });

const channelEventSchema = z.object({
  threadId: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
  chatType: z.enum(['private', 'group']).default('private'),
  externalMessageId: z.string().min(1).optional(),
  from: z.object({ id: z.string().min(1).optional(), name: z.string().optional(), handle: z.string().min(1).optional() }).optional(),
  text: z.string().default(''),
  /** The other people the message mentions (its text already reads `@Name`). */
  mentions: z.array(z.object({ id: z.string().min(1), name: z.string(), handle: z.string().min(1).optional() })).optional(),
  /** The group's display name when the platform gave one (Telegram); Slack and Discord are looked up. */
  chatTitle: z.string().min(1).optional(),
  /** A button tap: the agent message whose option this is. */
  replyToItemId: z.string().min(1).optional(),
  /** Files the message carries (fetched by the platform's attachment call once the message is admitted). */
  files: z.array(z.object({ fileId: z.string().min(1), name: z.string().min(1), mimeType: z.string().optional(), sizeBytes: z.number().int().min(0).optional() })).optional(),
  /** A group with people from another workspace or tenant: the agent speaks there only when addressed. */
  external: z.boolean().optional(),
});

/** Channel origin pinned on every channel conversation, so delivery can route the reply back. */
export interface ChannelMeta {
  kind: string;
  channelId: string;
  threadId: string;
  chatId: string;
}

export type SpeakerRole = 'owner' | 'stranger';

export type ChannelConversation = Conversation & { ownerId: string; channel: ChannelMeta };

type StoredChannelConversation = Conversation & { ownerId?: string; channel?: unknown; externalGroup?: boolean };

function digestHex(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
}

/**
 * Deterministic conversation id over the platform identity. A redelivered webhook carries the same
 * owner/kind/channel/thread, so it resolves to the same row instead of forking a second thread.
 */
export function channelConversationId(ownerId: string, kind: string, channelId: string, threadId: string): string {
  return 'cvn-' + digestHex([ownerId, kind, channelId, threadId]);
}

/** Deterministic item id for one platform message, so a redelivery replays the same row. */
export function channelItemId(conversationId: string, externalMessageId: string): string {
  return 'itm-' + digestHex([conversationId, externalMessageId]);
}

/**
 * Who is speaking, decided at ingress. A sender matching the owner's bound platform id is the owner;
 * everyone else is a stranger. An unbound channel makes everyone a stranger: a public bot is
 * reachable by anyone, so a private chat must never read as the owner before the owner has bound.
 */
export function speakerFor(ownerExternalId: string | undefined, fromId: string | undefined): SpeakerRole {
  return ownerExternalId !== undefined && fromId !== undefined && fromId === ownerExternalId ? 'owner' : 'stranger';
}

/** Read the channel origin off a stored conversation; undefined when it is not a channel chat. */
export function channelMetaOf(conv: Conversation): ChannelMeta | undefined {
  const raw: unknown = (conv as StoredChannelConversation).channel;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record: Record<string, unknown> = raw as Record<string, unknown>;
  const kind = record['kind'];
  const channelId = record['channelId'];
  const threadId = record['threadId'];
  const chatId = record['chatId'];
  if (typeof kind !== 'string' || typeof channelId !== 'string') return undefined;
  if (typeof threadId !== 'string' || typeof chatId !== 'string') return undefined;
  return { kind, channelId, threadId, chatId };
}


async function getOrCreateConversation(
  deps: AdmitDeps,
  ownerId: string,
  agentId: string,
  conversationId: string,
  event: IncomingChannelEvent,
  meta: ChannelMeta,
  channel: ChannelRow,
  now: string,
  ownerAgentName?: string,
): Promise<Conversation> {
  const existing = await deps.store.get('conversations', conversationId);
  if (existing) return existing;
  const title = ownerAgentName === undefined ? await chatTitleFor(deps, channel, event) : ownerChatTitle(deps.channels, channel, ownerAgentName);
  const created: ChannelConversation = {
    id: conversationId,
    kind: event.chatType === 'group' ? 'room' : 'direct',
    agentIds: [agentId],
    memberIds: [ownerId],
    unreadCount: 0,
    lastItemAt: now,
    createdAt: now,
    ownerId,
    channel: meta,
    ...(title === undefined ? {} : { title }),
  };
  if (event.chatType === 'group') created.roomMode = 'mention';
  await deps.store.put('conversations', created);
  await deps.store.emit({ type: 'conversation.created', conversation: created });
  return created;
}

/** What the ingress answers: the caller (route, webhook, poller) turns it into HTTP or ignores it. */
export interface AdmitResult {
  status: 200 | 202 | 403 | 404 | 409 | 503;
  body: Record<string, unknown>;
}

function refuse(status: AdmitResult['status'], code: string, message: string): AdmitResult {
  return { status, body: { error: { code, message } } };
}

export type AdmitDeps = Pick<AgentdDeps, 'store' | 'enqueuer' | 'channels' | 'channelFetch' | 'identity' | 'blobs'>;

/**
 * The one admission path for a platform event: route, webhook and poller all end here. A `/start`
 * deep link either binds the owner (and confirms through the platform) or is dropped; it never wakes
 * the agent. Everything else becomes a user_message item plus exactly one wake.
 */
export async function admitChannelEvent(
  deps: AdmitDeps,
  ownerId: string,
  kind: string,
  channelId: string,
  event: IncomingChannelEvent,
  /** Another of the owner's agents speaking in the chat (a Discord post that mentions this one): an untrusted agent-originated wake continuing `hop`. */
  peer?: { agentId: string; hop: { chainId: string; depth: number } },
): Promise<AdmitResult> {
  const channel = await deps.store.get('channels', channelRowId(kind, channelId));
  if (!channel || docOwnerId(channel) !== ownerId) {
    return refuse(404, 'CHANNEL_NOT_FOUND', 'Channel ' + kind + ':' + channelId + ' not found');
  }
  // The platform's plugin is off (JUNO_PLUGINS) or failed: nothing is admitted, so nothing is stored and no agent wakes silently.
  if (deps.channels.get(kind) === undefined) return refuse(503, 'CHANNEL_PLATFORM_UNAVAILABLE', unavailableMessage(kind));
  const agent = await deps.store.get('agents', channel.agentId);
  if (!agent) return refuse(404, 'AGENT_NOT_FOUND', 'Agent ' + channel.agentId + ' not found');
  if (!isAgentVisible(agent, ownerId)) return refuse(403, 'AGENT_FORBIDDEN', 'Agent not shared with you');
  // Owner binding: the platform tells us who the owner is (no code anyone types). On a channel it could not bind, the first private
  // message is held and the owner confirms it in the app. A bare `/start` is a deep-link open, never a message for the agent.
  if (isStartCommand(event.text)) return { status: 200, body: { received: false } };
  const held = await holdForOwnerConfirmation(deps, ownerId, channel, agent.name, event);
  if (held !== null) return held;
  const threadId = event.threadId ?? event.chatId ?? 'main';
  const chatId = event.chatId ?? event.threadId ?? 'main';
  const meta: ChannelMeta = { kind, channelId, threadId, chatId };
  const speakerRole = peer === undefined ? speakerFor(channel.ownerExternalId, event.from?.id) : 'stranger';
  // Identity: a human sender is recorded as an account (a peer agent is not a person). The owner's account is linked to the owner's
  // person; a stranger gets a person in a DM, or in a group only when the message addresses the agent.
  const speaker = peer === undefined && event.from?.id !== undefined
    ? await recordIngressSender(deps, ownerId, channel, { id: event.from.id, name: event.from.name }, { owner: speakerRole === 'owner', createPerson: addressesAgent(deps.channels, event.chatType, event.mentions, channel) }, event.chatTitle)
    : undefined;
  const now = new Date().toISOString();
  // Every platform chat is its own conversation (the owner's private chat "Telegram · Nova", a group, a stranger's chat); the app's main chat is app-only.
  const ownerDm = event.chatType === 'private' && speakerRole === 'owner';
  const conv = await getOrCreateConversation(deps, ownerId, channel.agentId, channelConversationId(ownerId, kind, channelId, threadId), event, meta, channel, now, ownerDm ? agent.name : undefined);
  const conversationId = conv.id;
  if (docOwnerId(conv) !== ownerId) return refuse(403, 'CHANNEL_FORBIDDEN', 'Channel conversation is not yours');
  const dedupeKey = event.externalMessageId;
  const source: ChannelOrigin = { kind, channelId, chatId, threadId, chatType: event.chatType };
  const itemId = dedupeKey === undefined ? 'itm-' + randomUUID() : channelItemId(conversationId, dedupeKey);
  const stored = dedupeKey === undefined ? null : await deps.store.get('items', itemId);
  if (stored && (stored.type !== 'user_message' || stored.text !== event.text)) {
    return refuse(409, 'ITEM_CONFLICT', 'Message id was already used with different content');
  }
  // The files go to the library before the item names them. A redelivery (the message is stored already) fetches nothing again.
  const files = event.files === undefined || stored !== null ? { attachments: [], ids: [] } : await storeInboundFiles(deps, ownerId, channel, event.files, event.externalMessageId ?? '');
  // The group's outside-members flag (Slack Connect, a Feishu external group) is kept on the conversation: delivery reads it.
  if (event.chatType === 'group' && event.external !== undefined && Boolean((conv as StoredChannelConversation).externalGroup) !== event.external) {
    const flag: Partial<Conversation> & { externalGroup: boolean } = { externalGroup: event.external };
    await deps.store.patch('conversations', conversationId, flag);
  }
  const item: Extract<Item, { type: 'user_message' }> = {
    id: itemId,
    conversationId,
    type: 'user_message',
    at: now,
    // The speaker, not the account the channel belongs to (that scopes the row through owner_id): the owner's id only when the owner spoke.
    authorId: channelAuthorId(ownerId, { role: speakerRole, kind, externalId: event.from?.id ?? 'unknown' }),
    text: event.text,
    attachments: files.attachments,
    mentions: [],
    ...(event.from?.id === undefined ? {} : { channelSender: { kind, externalId: event.from.id, name: event.from.name ?? '', role: speakerRole } }),
    source,
  };
  if (!stored) {
    await deps.store.tx(async (store) => {
      await store.put('items', item, { conversationId });
      await emitItemAdded(store, conversationId, item);
    });
  }
  // A group mention brings the chat just before it (Discord, Slack) as read-only context; it is not stored as items.
  const history = event.chatType === 'group' ? await fetchGroupHistory(deps, channel, { chatId, threadId, ...(event.externalMessageId === undefined ? {} : { externalMessageId: event.externalMessageId }) }) : undefined;
  const mentioned = await classifyMentions(deps.store, channel, event.mentions);
  // Another of the owner's agents speaking: its name and role (the stored message keeps `agent:<id>` as its sender id, which marks it as an agent's).
  const sender = peer === undefined ? {} : await peerSenderPayload(deps.store, peer.agentId);
  const wake = wakeEventSchema.parse({
    id: 'wk-chan-' + conversationId + '-' + (dedupeKey ?? itemId),
    ownerId,
    agentId: channel.agentId,
    sessionKey: sessionKey(channel.agentId, conversationId),
    conversationId,
    kind: event.chatType === 'group' ? 'room_mention' : 'user_message',
    origin: peer === undefined ? { type: 'user' } : { type: 'agent', id: peer.agentId },
    trusted: speakerRole === 'owner',
    priority: peer === undefined ? 'user' : 'peer',
    ...(peer === undefined ? {} : { hop: peer.hop }),
    payload: {
      text: event.text,
      itemId,
      speakerRole: peer === undefined ? speakerRole : 'agent',
      ...sender,
      ...(event.from?.name ? { speakerName: event.from.name } : {}),
      ...(event.from?.id === undefined ? {} : { speakerId: event.from.id }),
      ...(speaker === undefined ? {} : { personId: speaker.id }),
      ...(event.from?.handle === undefined ? {} : { speakerHandle: event.from.handle }),
      ...(mentioned.length === 0 ? {} : { mentions: mentioned }),
      channelKind: kind,
      channelId,
      chatId,
      threadId,
      ...(history === undefined ? {} : { channelContext: history }),
      ...(event.externalMessageId === undefined ? {} : { externalMessageId: event.externalMessageId }),
      ...(event.replyToItemId === undefined ? {} : { replyToItemId: event.replyToItemId }),
      ...(files.ids.length === 0 ? {} : { attachmentIds: files.ids }),
    },
    at: now,
    status: 'accepted',
  });
  const failed = refuse(503, 'WAKE_ENQUEUE_FAILED', 'Message stored but the agent was not woken');
  try {
    const enqueued = await deps.enqueuer.enqueue(wake);
    if (!enqueued.accepted) return failed;
  } catch {
    return failed;
  }
  // Show people the message was picked up: a 👀 on it until the run ends (best-effort, delivery takes it off).
  if (peer === undefined && event.externalMessageId !== undefined) {
    void startWorking(deps, ownerId, conversationId, source, event.externalMessageId.slice(event.externalMessageId.lastIndexOf(':') + 1));
  }
  // A group the platform may not be able to read yet: its plugin may probe that (fire and forget), e.g. Feishu's group-read scope.
  if (event.chatType === 'group') void deps.channels.get(kind)?.groupAdmitted?.(deps, channel, { chatId, threadId })?.catch(() => undefined);
  return { status: 202, body: { received: true, conversationId } };
}

/**
 * The generic inbound route every platform's per-channel events use. A platform's own routes (the Slack shared events and button
 * taps, the Discord OAuth redirect) are registered by its plugin through `ctx.http.route`, not here.
 */
export function registerChannels(app: Hono, deps: AgentdDeps): void {
  app.post('/v1/channels/:kind/:channelId/events', async (c) => {
    const ownerId = getOwnerId(c);
    const kind = c.req.param('kind');
    const channelId = c.req.param('channelId');
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: { code: 'INVALID_CHANNEL_EVENT', message: 'Channel event body must be JSON' } }, 400);
    }
    // A body the platform answers first and admits after (Slack with files; see ChannelRegistration.answersFirst).
    if (deps.channels.get(kind)?.answersFirst?.(raw) === true) return acknowledgeThenAdmit(c, () => admitPlatformEvent(deps, ownerId, kind, channelId, raw));
    const answer = await admitPlatformEvent(deps, ownerId, kind, channelId, raw);
    return c.json(answer.body, answer.status);
  });
}

/** What the generic events route answers: the status and body the caller sends back. */
interface PlatformAnswer {
  status: 200 | 202 | 400 | 403 | 404 | 409 | 503;
  body: Record<string, unknown>;
}

/** A platform event from its webhook body to the one admission path: the plugin's webhook shape, the parse, then `admitChannelEvent`. */
async function admitPlatformEvent(deps: AgentdDeps, ownerId: string, kind: string, channelId: string, body: unknown): Promise<PlatformAnswer> {
  let raw = body;
  // The platform's own webhook shapes (Telegram updates and button taps, Slack events) are turned into the shared event by its plugin.
  const prepared = await deps.channels.get(kind)?.webhook?.({ deps, ownerId, channelId, body: raw });
  if (prepared !== undefined) {
    if ('answered' in prepared) return { status: 200, body: { received: false } };
    raw = prepared.event;
  }
  const parsed = channelEventSchema.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: { code: 'INVALID_CHANNEL_EVENT', message: 'Invalid channel event' } } };
  const event = parsed.data;
  if (event.text.trim().length === 0 && event.externalMessageId === undefined) {
    return { status: 400, body: { error: { code: 'INVALID_CHANNEL_EVENT', message: 'Channel event carries no message' } } };
  }
  return admitChannelEvent(deps, ownerId, kind, channelId, event);
}

/**
 * A platform that answers late gets retried (Slack gives an events endpoint 3 seconds). A body the platform's plugin says to answer
 * first (ChannelRegistration.answersFirst; Slack with files) is acknowledged at once (200) and admitted after: its files are
 * downloaded before the agent is woken, which can take longer than the platform waits. A failure after the acknowledgement is
 * logged, not retried (the platform would not resend it). Exported for the platform plugins' own routes.
 */
export function acknowledgeThenAdmit(c: Context, admit: () => Promise<unknown>): Response {
  admit().catch((err: unknown) => log.warn({ err }, 'channel event was not admitted after its acknowledgement'));
  return c.json({ received: true }, 200);
}
