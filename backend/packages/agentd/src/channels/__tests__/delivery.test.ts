/**
 * CH1 outbound delivery: the run's reply reaches the platform once. A replayed run sees the
 * existing eventReceipt and does not send again; a failed send is recorded instead of dropped.
 * The platform is a fake seam; no live network happens here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { Conversation } from '@agent-desktop/public-contracts';
import { eventReceiptId } from 'juno-agent/execution/harness/services/event-receipts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import type { AgentEvent } from '@agent-desktop/public-contracts';
import { deliverChannelReply, startChannelDelivery, type ChannelSender, type ChannelSenders } from '../delivery.js';
import { loadTestChannels } from '../../__tests__/test-app.js';

const OWNER = 'owner-1';
const AT = '2026-10-19T00:00:00.000Z';

type ChannelConversation = Conversation & { ownerId: string; channel: { kind: string; channelId: string; threadId: string; chatId: string } };

function makeConversation(id: string, channel: ChannelConversation['channel'] | undefined): ChannelConversation {
  const base: ChannelConversation = {
    id,
    kind: 'direct',
    agentIds: ['agent-1'],
    memberIds: [OWNER],
    unreadCount: 0,
    lastItemAt: AT,
    createdAt: AT,
    ownerId: OWNER,
    channel: { kind: 'telegram', channelId: 'bot-1', threadId: 't1', chatId: 'chat-9' },
  };
  if (channel === undefined) {
    const { channel: _dropped, ...rest } = base;
    return rest as ChannelConversation;
  }
  return { ...base, channel };
}

interface FakeSender extends ChannelSender {
  calls: Array<{ chatId: string; text: string; token: string | undefined }>;
  failNext: boolean;
}

function makeSender(): FakeSender {
  const sender: FakeSender = {
    calls: [],
    failNext: false,
    async sendText(target, text) {
      sender.calls.push({ chatId: target.chatId, text, token: target.channel.botToken });
      if (sender.failNext) {
        sender.failNext = false;
        return { ok: false, error: 'upstream down' };
      }
      return { ok: true, externalId: 'tg-1' };
    },
  };
  return sender;
}

/** The senders of a host that registered only Telegram, with the fake in its place. */
const only = (sender: ChannelSender): ChannelSenders => (kind) => (kind === 'telegram' ? sender : undefined);

describe('channel delivery', () => {
  let store: Store;
  let sender: FakeSender;

  beforeEach(async () => {
    store = createMemoryStore();
    sender = makeSender();
    await store.put('channels', {
      id: 'telegram:bot-1',
      ownerId: OWNER,
      agentId: 'agent-1',
      kind: 'telegram',
      channelId: 'bot-1',
      secretHashHex: 'hash',
      botToken: 'bot-token',
      createdAt: AT,
      updatedAt: AT,
    });
    await store.put('conversations', makeConversation('cvn-1', { kind: 'telegram', channelId: 'bot-1', threadId: 't1', chatId: 'chat-9' }));
    await store.put('items', {
      id: 'itm-reply-1',
      conversationId: 'cvn-1',
      type: 'agent_message',
      agentId: 'agent-1',
      runId: 'run-1',
      markdown: 'hello from the agent',
      citations: [],
      at: AT,
    });
  });

  it('sends the reply once: a replayed run is a duplicate', async () => {
    const first = await deliverChannelReply(store, only(sender), { ownerId: OWNER, conversationId: 'cvn-1', itemId: 'itm-reply-1' });
    expect(first).toEqual({ status: 'sent', externalId: 'tg-1' });
    const replay = await deliverChannelReply(store, only(sender), { ownerId: OWNER, conversationId: 'cvn-1', itemId: 'itm-reply-1' });
    expect(replay).toEqual({ status: 'duplicate' });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toEqual({ chatId: 'chat-9', text: 'hello from the agent', token: 'bot-token' });
    const receipt = await store.get(
      'eventReceipts',
      eventReceiptId({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1' }, 'channel', 'send', 'itm-reply-1'),
    );
    expect(receipt?.runId).toBe('run-1');
  });

  it('records a failed send instead of dropping it, and a retry still delivers', async () => {
    sender.failNext = true;
    const failed = await deliverChannelReply(store, only(sender), { ownerId: OWNER, conversationId: 'cvn-1', itemId: 'itm-reply-1' });
    expect(failed).toEqual({ status: 'failed', error: 'upstream down' });
    const failure = await store.get(
      'eventReceipts',
      eventReceiptId({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1' }, 'channel', 'send-failed', 'itm-reply-1'),
    );
    expect(failure?.eventId).toBe('itm-reply-1');
    const retry = await deliverChannelReply(store, only(sender), { ownerId: OWNER, conversationId: 'cvn-1', itemId: 'itm-reply-1' });
    expect(retry.status).toBe('sent');
    expect(sender.calls).toHaveLength(2);
  });

  it('looks the platform up in the plugin host: a disabled platform plugin fails visibly with a receipt, never silently', async () => {
    const off = await loadTestChannels({ telegram: { enabled: false } });
    const failed = await deliverChannelReply(store, off.senders(), { ownerId: OWNER, conversationId: 'cvn-1', itemId: 'itm-reply-1' });
    expect(failed.status).toBe('failed');
    expect(failed.status === 'failed' && failed.error).toMatch(/telegram platform is not available.*plugin is disabled/);
    const failure = await store.get(
      'eventReceipts',
      eventReceiptId({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1' }, 'channel', 'send-failed', 'itm-reply-1'),
    );
    expect(failure?.eventId).toBe('itm-reply-1');
    // With the plugin on, the same reply goes out through the platform's own transport.
    const on = await loadTestChannels();
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input) => { urls.push(String(input)); return Response.json({ ok: true, result: { message_id: 7 } }); };
    const sent = await deliverChannelReply(store, on.senders(fetchFn), { ownerId: OWNER, conversationId: 'cvn-1', itemId: 'itm-reply-1' });
    expect(sent).toEqual({ status: 'sent', externalId: '7' });
    expect(urls.some((url) => url.includes('/sendMessage'))).toBe(true);
  });

  it('skips conversations without a channel origin and items that are not replies', async () => {
    await store.put('conversations', makeConversation('cvn-plain', undefined));
    await store.put('items', {
      id: 'itm-user-1',
      conversationId: 'cvn-plain',
      type: 'user_message',
      authorId: OWNER,
      text: 'hi',
      attachments: [],
      mentions: [],
      at: AT,
    });
    expect(await deliverChannelReply(store, only(sender), { ownerId: OWNER, conversationId: 'cvn-plain', itemId: 'itm-user-1' }))
      .toEqual({ status: 'skipped' });
    expect(await deliverChannelReply(store, only(sender), { ownerId: OWNER, conversationId: 'cvn-plain', itemId: 'missing' }))
      .toEqual({ status: 'skipped' });
    expect(sender.calls).toHaveLength(0);
  });

  it('delivers an agent_message from the event bus with the sealed token opened', async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
    try {
      await store.patch('channels', 'telegram:bot-1', { botToken: encryptSecret('real-token') });
      let onEvent: ((stored: { event: AgentEvent }) => void) | undefined;
      const bus = { subscribe: async (fn: (stored: { event: AgentEvent }) => void) => { onEvent = fn; return () => undefined; } };
      await startChannelDelivery({ store, bus, senders: only(sender) });
      const item = await store.get('items', 'itm-reply-1');
      if (!item) throw new Error('seed item missing');
      const event: AgentEvent = { type: 'item.added', conversationId: 'cvn-1', item };
      onEvent?.({ event });
      await vi.waitFor(() => expect(sender.calls.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sender.calls).toEqual([{ chatId: 'chat-9', text: 'hello from the agent', token: 'real-token' }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
