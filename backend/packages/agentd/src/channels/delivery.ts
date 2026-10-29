/**
 * Outbound channel delivery (CH1): send the run's reply back to the platform.
 *
 * A consumer of `agent_message` items in a channel-origin conversation calls the platform send,
 * then records an idempotency receipt in the existing `eventReceipts` collection, so a replayed run
 * sends once. A failed send records a `send-failed` receipt instead of being dropped, so the failure
 * is visible and a retry still delivers. The Telegram HTTPS call sits behind the `ChannelSender`
 * seam, which tests replace with a fake; no live network happens in tests.
 */
import { parseStoredRequest, type Store } from '@agent-desktop/contracts';
import type { AgentEvent, ChannelOrigin } from '@agent-desktop/public-contracts';
import { createLogger } from '@agent-desktop/log';
import { eventReceiptId } from 'juno-agent/execution/harness/services/event-receipts';
import { unavailableMessage, type ChannelSenders } from './registry.js';
import { finishWorking } from './working.js';
import { plainText, richFromItem, richFromRequest, type RichMessage } from '@agent-desktop/channels/render';
import type { ChannelSender, ChannelSendResult, ChannelSendTarget } from '@agent-desktop/channels/types';
import { channelMetaOf } from '../routes/channels.js';
import { docOwnerId } from '../routes/relationships.js';
import { identityOf, openChannelRow } from './credentials.js';
import { markMentions } from '@agent-desktop/channels/mentions';
import { holdsQuietReply, originOfItem, originOfRequest } from './origin.js';
import type { ReplyPlan } from '@agent-desktop/channels/types';

export type { ChannelSender, ChannelSendResult, ChannelSendTarget };

const log = createLogger({ service: 'agentd' });

/** The `metadata.juno` object of a standard event, when it carries one. */
function junoMetadataOf(event: AgentEvent): Record<string, unknown> {
  const metadata = (event as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return {};
  const juno = (metadata as { juno?: unknown }).juno;
  return typeof juno === 'object' && juno !== null ? (juno as Record<string, unknown>) : {};
}

export type { ChannelSenders };

export interface ChannelReplyInput {
  ownerId: string;
  conversationId: string;
  itemId: string;
}

export type ChannelDeliveryOutcome =
  | { status: 'sent'; externalId?: string }
  | { status: 'duplicate' }
  | { status: 'failed'; error: string }
  | { status: 'skipped' };

function sendFailed(result: ChannelSendResult): result is { ok: false; error: string } {
  return !result.ok;
}

function failureReceipt(store: Store, scope: { ownerId: string; agentId: string; conversationId: string }, item: { id: string; runId?: string }, now: string) {
  return store.put('eventReceipts', {
    id: eventReceiptId(scope, 'channel', 'send-failed', item.id),
    agentId: scope.agentId,
    conversationId: scope.conversationId,
    runId: item.runId ?? scope.conversationId,
    source: 'channel',
    type: 'send-failed',
    eventId: item.id,
    consumedAt: now,
    createdAt: now,
  });
}

/**
 * Deliver one agent reply to its channel. Non-channel conversations and non-reply items are skipped
 * (nothing to deliver); everything else either sends once or records why it did not.
 */
export async function deliverChannelReply(
  store: Store,
  senders: ChannelSenders,
  input: ChannelReplyInput,
): Promise<ChannelDeliveryOutcome> {
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
  input: { ownerId: string; conversationId: string; requestId: string },
): Promise<ChannelDeliveryOutcome> {
  const stored = await store.get('requests', input.requestId);
  if (!stored || stored.conversationId !== input.conversationId || stored.status !== 'pending') return { status: 'skipped' };
  const rich = richFromRequest(parseStoredRequest(stored));
  if (rich === undefined) return { status: 'skipped' };
  const asked = await originOfRequest(store, stored);
  return deliverRich(store, senders, input, { id: stored.id, agentId: stored.agentId, ...(stored.runId === undefined ? {} : { runId: stored.runId }) }, rich, asked?.origin);
}

async function deliverRich(
  store: Store,
  senders: ChannelSenders,
  input: { ownerId: string; conversationId: string },
  item: { id: string; agentId: string; runId?: string },
  rich: RichMessage,
  meta: ChannelOrigin | undefined,
): Promise<ChannelDeliveryOutcome> {
  // No origin: the run was woken in the app (or by nothing a platform said), so the reply stays in the app.
  if (!meta) return { status: 'skipped' };
  const scope = { ownerId: input.ownerId, agentId: item.agentId, conversationId: input.conversationId };
  const now = new Date().toISOString();
  const receiptId = eventReceiptId(scope, 'channel', 'send', item.id);
  const existing = await store.get('eventReceipts', receiptId);
  if (existing) return { status: 'duplicate' };
  const row = await store.get('channels', meta.kind + ':' + meta.channelId);
  const opened = row !== null && docOwnerId(row) !== input.ownerId ? { error: 'Channel not found' } : await openChannelRow(store, row);
  const sender = senders(meta.kind);
  if ('error' in opened || sender === undefined) {
    // A disabled or missing platform plugin lands here for every existing channel of that platform: recorded and logged, never dropped.
    if (sender === undefined) log.warn({ kind: meta.kind, channelId: meta.channelId, itemId: item.id }, 'channel reply not delivered: ' + unavailableMessage(meta.kind));
    await failureReceipt(store, scope, item, now);
    return { status: 'failed', error: 'error' in opened ? opened.error : unavailableMessage(meta.kind) };
  }
  let result: ChannelSendResult;
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
    ...(identity === undefined ? {} : { identity }),
    ...(installation === undefined ? {} : {
      installation,
      persistInstallation: async (patch) => { await store.patch('channelInstallations', installation.id, { ...patch, updatedAt: new Date().toISOString() }); },
    }),
  };
  try {
    result = sender.sendRich === undefined ? await sender.sendText(target, plainText(rich)) : await sender.sendRich(target, rich);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (sendFailed(result)) {
    await failureReceipt(store, scope, item, now);
    return { status: 'failed', error: result.error };
  }
  // A post on an install (Discord): remember which agent/run wrote each message, so a later role mention in it can wake the other agent.
  if (installation !== undefined && result.externalIds !== undefined && hooks?.sent !== undefined) {
    await hooks.sent({ store, conversationId: input.conversationId, item, externalIds: result.externalIds, now });
  }
  await store.put('eventReceipts', {
    id: receiptId,
    agentId: item.agentId,
    conversationId: input.conversationId,
    runId: item.runId ?? input.conversationId,
    source: 'channel',
    type: 'send',
    eventId: item.id,
    consumedAt: now,
    createdAt: now,
  });
  return result.externalId === undefined ? { status: 'sent' } : { status: 'sent', externalId: result.externalId };
}

/**
 * agentd start-up: every committed `agent_message` is offered to delivery (channel conversations only;
 * everything else is skipped, and the receipt makes a repeat a no-op). The owner comes from the
 * conversation row. Returns the unsubscribe for shutdown.
 */
export async function startChannelDelivery(args: {
  store: Store;
  bus: { subscribe(onEvent: (stored: { event: AgentEvent }) => void): Promise<() => void> };
  senders: ChannelSenders;
}): Promise<() => void> {
  const deliver = async (conversationId: string, itemId: string, request = false, hasReplyTo = false): Promise<void> => {
    try {
      const conv = await args.store.get('conversations', conversationId);
      if (!conv) return;
      // An app-only conversation has nothing to deliver; the origin of each reply is checked again in deliverRich.
      if (!request && channelMetaOf(conv) === undefined && !hasReplyTo) return;
      const owner = (conv as { ownerId?: unknown }).ownerId;
      if (typeof owner !== 'string') return;
      if (request) await deliverChannelRequest(args.store, args.senders, { ownerId: owner, conversationId, requestId: itemId });
      else await deliverChannelReply(args.store, args.senders, { ownerId: owner, conversationId, itemId });
    } catch (err) {
      log.warn({ err, conversationId }, 'channel delivery skipped');
    }
  };
  return args.bus.subscribe(({ event }) => {
    if (event.type === 'item.added' && event.item.type === 'agent_message') void deliver(event.conversationId, event.item.id, false, event.item.replyTo !== undefined);
    if (event.type === 'request.created' && event.request.conversationId !== undefined) void deliver(event.request.conversationId, event.request.id, true);
    // The run is over, whatever the outcome (a failed run closes with RUN_ERROR): the "working" reaction comes off the message that started it.
    if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
      const juno = junoMetadataOf(event);
      const conversationId = juno['conversationId'];
      if (typeof conversationId === 'string') void finishWorking(conversationId);
    }
  });
}
