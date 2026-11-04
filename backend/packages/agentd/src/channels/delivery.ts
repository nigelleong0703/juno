/**
 * Outbound channel delivery (CH1): one attempt to send a reply or a question card to its platform chat. WHAT is sent and WHEN is the outbox's
 * business (outbox/, BACKEND 5.7.11): a row per message, retried until it is sent or given up on. This file only knows how to try once and say
 * what happened, in the outbox's vocabulary: sent, nothing to send, or failed (with whether trying again can help). The platform HTTPS call sits
 * behind the `ChannelSender` seam, which tests replace with a fake; no live network happens in tests.
 */
import { channelRowId, parseStoredRequest, type Store } from '@agent-desktop/contracts';
import type { ChannelOrigin } from '@agent-desktop/public-contracts';
import { createLogger } from '@agent-desktop/log';
import { unavailableMessage, type ChannelSenders } from './registry.js';
import { plainText, richFromItem, richFromRequest, type RichMessage } from '@agent-desktop/channels/render';
import type { ChannelSender, ChannelSendResult, ChannelSendTarget, ReplyPlan } from '@agent-desktop/channels/types';
import type { SendFailure } from '@agent-desktop/channels/failure';
import { docOwnerId } from '../routes/relationships.js';
import { identityOf, openChannelRow } from './credentials.js';
import { markMentions } from '@agent-desktop/channels/mentions';
import { postedReceipt } from './posted.js';
import { conversationOrigin, holdsQuietReply, originOfItem, originOfRequest } from './origin.js';

export type { ChannelSender, ChannelSendResult, ChannelSendTarget };

const log = createLogger({ service: 'agentd' });

export type { ChannelSenders };

export interface ChannelReplyInput {
  ownerId: string;
  conversationId: string;
  itemId: string;
  /** The outbox row's id, for the platforms that can recognise a repeat (Discord, Feishu). */
  idempotencyKey?: string;
}

/** A failure the outbox acts on: the platform's own reading, or `platform_unavailable` (its plugin is off: wait, do not give up). */
export type DeliveryFailure = SendFailure | { kind: 'platform_unavailable' };

export type ChannelDeliveryOutcome =
  | { status: 'sent'; externalId?: string }
  | { status: 'failed'; error: string; failure: DeliveryFailure }
  | { status: 'skipped' };

/** What a channel row that cannot be opened means: the channel or its installation is gone (permanent for this chat), or the credential cannot be used. */
function openFailure(error: string): DeliveryFailure {
  return { kind: /not found|is gone/i.test(error) ? 'channel_gone' : 'token_invalid' };
}

/**
 * Try to deliver one agent reply to its channel. Non-channel conversations and non-reply items are skipped (nothing to deliver).
 */
export async function deliverChannelReply(store: Store, senders: ChannelSenders, input: ChannelReplyInput): Promise<ChannelDeliveryOutcome> {
  const item = await store.get('items', input.itemId);
  if (!item || item.type !== 'agent_message') return { status: 'skipped' };
  if (item.conversationId !== input.conversationId) return { status: 'skipped' };
  const conv = await store.get('conversations', input.conversationId);
  // The outside-members rule: a quiet group gets no reply it was not addressed for (the item is kept, nothing is sent).
  if (holdsQuietReply(conv, item)) return { status: 'skipped' };
  const origin = conv === null ? undefined : originOfItem(item, conv);
  return deliverRich(store, senders, input, { id: item.id, agentId: item.agentId, ...(item.runId === undefined ? {} : { runId: item.runId }) }, richFromItem(item), origin);
}

/**
 * Ask a pending question or approval on the platform: its options as buttons (the answer comes back through the
 * interaction handlers). Other request kinds, and requests of other conversations, are skipped.
 */
export async function deliverChannelRequest(
  store: Store,
  senders: ChannelSenders,
  input: { ownerId: string; conversationId: string; requestId: string; idempotencyKey?: string },
): Promise<ChannelDeliveryOutcome> {
  const stored = await store.get('requests', input.requestId);
  if (!stored || stored.conversationId !== input.conversationId || stored.status !== 'pending') return { status: 'skipped' };
  const rich = richFromRequest(parseStoredRequest(stored));
  if (rich === undefined) return { status: 'skipped' };
  if (stored.payload.kind === 'approval' && stored.payload.askedBy !== undefined) await ensureOwnerChat(store, senders, stored.conversationId);
  const asked = await originOfRequest(store, stored);
  return deliverRich(store, senders, input, { id: stored.id, agentId: stored.agentId, ...(stored.runId === undefined ? {} : { runId: stored.runId }) }, rich, asked?.origin);
}

/**
 * The owner's private chat with the agent on the platform, for the approvals other people's asks raise (BACKEND 6.8): known from the
 * owner's earlier private message, else opened through the platform (`openDirect`) and remembered on the channel row. Best effort.
 */
export async function ensureOwnerChat(store: Store, senders: ChannelSenders, conversationId: string | undefined): Promise<void> {
  const conv = conversationId === undefined ? null : await store.get('conversations', conversationId);
  const pinned = conv === null ? undefined : conversationOrigin(conv);
  const row = pinned === undefined ? null : await store.get('channels', channelRowId(pinned.kind, pinned.channelId));
  if (pinned === undefined || row === null || row.ownerChatId !== undefined || row.ownerExternalId === undefined) return;
  const open = senders(pinned.kind)?.openDirect;
  const opened = await openChannelRow(store, row);
  if (open === undefined || 'error' in opened || opened.channel.botToken === undefined) return;
  const chatId = await open(opened.channel.botToken, row.ownerExternalId).catch(() => undefined);
  if (chatId !== undefined) await store.patch('channels', row.id, { ownerChatId: chatId, updatedAt: new Date().toISOString() });
}

async function deliverRich(
  store: Store,
  senders: ChannelSenders,
  input: { ownerId: string; conversationId: string; idempotencyKey?: string },
  item: { id: string; agentId: string; runId?: string },
  rich: RichMessage,
  meta: ChannelOrigin | undefined,
): Promise<ChannelDeliveryOutcome> {
  // No origin: the run was woken in the app (or by nothing a platform said), so the reply stays in the app.
  if (!meta) return { status: 'skipped' };
  const now = new Date().toISOString();
  const row = await store.get('channels', meta.kind + ':' + meta.channelId);
  const opened = row !== null && docOwnerId(row) !== input.ownerId ? { error: 'Channel not found' } : await openChannelRow(store, row);
  const sender = senders(meta.kind);
  // A disabled or missing platform plugin lands here for every existing channel of that platform: the outbox waits for it to come back.
  if (sender === undefined) {
    log.warn({ kind: meta.kind, channelId: meta.channelId, itemId: item.id }, 'channel delivery waits: ' + unavailableMessage(meta.kind));
    return { status: 'failed', error: unavailableMessage(meta.kind), failure: { kind: 'platform_unavailable' } };
  }
  if ('error' in opened) return { status: 'failed', error: opened.error, failure: openFailure(opened.error) };
  if (row !== null && row.status === 'invalid_token') return { status: 'failed', error: 'The channel credential was refused earlier', failure: { kind: 'token_invalid' } };
  const identity = await identityOf(store, opened.channel);
  const installation = opened.installation;
  const plan = await (sender.planReply?.(opened.channel.botToken ?? '', meta, rich.text, { ...(opened.channel.botUserId === undefined ? {} : { botUserId: opened.channel.botUserId }), webhookIds: new Set(Object.values(installation?.webhooks ?? {}).map((hook) => hook.id)) }) ?? Promise.resolve<ReplyPlan>({ quote: false, people: [] })).catch((): ReplyPlan => ({ quote: false, people: [] }));
  if (plan.people.length > 0) rich = { ...rich, text: markMentions(rich.text, plan.people) };
  // The platform's own outbound hooks (Discord: agent role mentions), when it has any and the chat belongs to an install.
  const hooks = sender.delivery;
  if (installation !== undefined && hooks?.prepareText !== undefined) rich = { ...rich, text: await hooks.prepareText({ store, installationId: installation.id, senderAgentId: item.agentId, text: rich.text }) };
  const target: ChannelSendTarget = {
    channel: opened.channel,
    chatId: meta.chatId,
    threadId: meta.threadId ?? meta.chatId,
    ...(meta.chatType === undefined ? {} : { chatType: meta.chatType }),
    ...(!plan.quote || meta.messageId === undefined ? {} : { replyToMessageId: meta.messageId }),
    ...(!plan.quote || meta.userId === undefined ? {} : { replyToUserId: meta.userId }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    ...(identity === undefined ? {} : { identity }),
    ...(installation === undefined ? {} : {
      installation,
      persistInstallation: async (patch) => { await store.patch('channelInstallations', installation.id, { ...patch, updatedAt: new Date().toISOString() }); },
    }),
  };
  let result: ChannelSendResult;
  try {
    result = sender.sendRich === undefined ? await sender.sendText(target, plainText(rich)) : await sender.sendRich(target, rich);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) return { status: 'failed', error: result.error, failure: result.failure ?? { kind: 'transient' } };
  // A post on an install (Discord): remember which agent/run wrote each message, so a later role mention in it can wake the other agent.
  if (installation !== undefined && result.externalIds !== undefined && hooks?.sent !== undefined) {
    await hooks.sent({ store, conversationId: input.conversationId, item, externalIds: result.externalIds, now });
  }
  // The agent's own post is remembered by its platform id, so a later reply to it (a thread under it) is known to answer the agent (BACKEND 6.8).
  if (result.externalId !== undefined) await store.put('eventReceipts', postedReceipt(input.ownerId, item.agentId, row?.id ?? meta.kind + ':' + meta.channelId, meta.chatId, result.externalId, now));
  return result.externalId === undefined ? { status: 'sent' } : { status: 'sent', externalId: result.externalId };
}
