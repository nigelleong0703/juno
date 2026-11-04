/**
 * CH1 outbound delivery, one attempt: the reply reaches the platform with the sealed token opened, and every way it cannot is said in the outbox's
 * vocabulary (a failure the platform describes, a platform plugin that is off, nothing to send). Retrying, ordering and giving up are the outbox's
 * (outbox/__tests__/sender.test.ts). The platform is a fake seam; no live network happens here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { Conversation } from '@agent-desktop/public-contracts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import { deliverChannelReply, type ChannelSender, type ChannelSenders } from '../delivery.js';
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
  calls: Array<{ chatId: string; text: string; token: string | undefined; key: string | undefined }>;
  next: Awaited<ReturnType<ChannelSender['sendText']>>;
}

function makeSender(): FakeSender {
  const sender: FakeSender = {
    calls: [],
    next: { ok: true, externalId: 'tg-1' },
    async sendText(target, text) {
      sender.calls.push({ chatId: target.chatId, text, token: target.channel.botToken, key: target.idempotencyKey });
      return sender.next;
    },
  };
  return sender;
}

/** The senders of a host that registered only Telegram, with the fake in its place. */
const only = (sender: ChannelSender): ChannelSenders => (kind) => (kind === 'telegram' ? sender : undefined);

describe('channel delivery attempt', () => {
  let store: Store;
  let sender: FakeSender;
  const input = { ownerId: OWNER, conversationId: 'cvn-1', itemId: 'itm-reply-1', idempotencyKey: 'obx:reply:itm-reply-1' };

  beforeEach(async () => {
    store = createMemoryStore();
    sender = makeSender();
    await store.put('channels', {
      id: 'telegram:bot-1', ownerId: OWNER, agentId: 'agent-1', kind: 'telegram', channelId: 'bot-1', secretHashHex: 'hash', botToken: 'bot-token', createdAt: AT, updatedAt: AT,
    });
    await store.put('conversations', makeConversation('cvn-1', { kind: 'telegram', channelId: 'bot-1', threadId: 't1', chatId: 'chat-9' }));
    await store.put('items', { id: 'itm-reply-1', conversationId: 'cvn-1', type: 'agent_message', agentId: 'agent-1', runId: 'run-1', markdown: 'hello from the agent', citations: [], at: AT });
  });

  it('sends the reply with the outbox row id as the idempotency key and remembers the post by its platform id', async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
    try {
      await store.patch('channels', 'telegram:bot-1', { botToken: encryptSecret('real-token') });
      expect(await deliverChannelReply(store, only(sender), input)).toEqual({ status: 'sent', externalId: 'tg-1' });
      expect(sender.calls).toEqual([{ chatId: 'chat-9', text: 'hello from the agent', token: 'real-token', key: 'obx:reply:itm-reply-1' }]);
      const posted = await store.list('eventReceipts', { limit: 10 });
      expect(posted.items.map((receipt) => receipt.type)).toEqual(['posted']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('says what the platform said about a failure, and treats one it did not describe as transient', async () => {
    sender.next = { ok: false, error: 'chat not found', failure: { kind: 'channel_gone' } };
    expect(await deliverChannelReply(store, only(sender), input)).toEqual({ status: 'failed', error: 'chat not found', failure: { kind: 'channel_gone' } });
    sender.next = { ok: false, error: 'upstream down' };
    expect(await deliverChannelReply(store, only(sender), input)).toEqual({ status: 'failed', error: 'upstream down', failure: { kind: 'transient' } });
  });

  it('looks the platform up in the plugin host: a disabled plugin is "platform unavailable" (the outbox waits), and the same reply goes out once it is on', async () => {
    const off = await loadTestChannels({ telegram: { enabled: false } });
    const waiting = await deliverChannelReply(store, off.senders(), input);
    expect(waiting).toMatchObject({ status: 'failed', failure: { kind: 'platform_unavailable' } });
    expect(waiting.status === 'failed' && waiting.error).toMatch(/telegram platform is not available.*plugin is disabled/);
    const on = await loadTestChannels();
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (target) => { urls.push(String(target)); return Response.json({ ok: true, result: { message_id: 7 } }); };
    expect(await deliverChannelReply(store, on.senders(fetchFn), input)).toEqual({ status: 'sent', externalId: '7' });
    expect(urls.some((url) => url.includes('/sendMessage'))).toBe(true);
  });

  it('reads a channel that is gone or has no usable credential as permanent', async () => {
    await store.delete('channels', 'telegram:bot-1');
    expect(await deliverChannelReply(store, only(sender), input)).toMatchObject({ status: 'failed', failure: { kind: 'channel_gone' } });
    await store.put('channels', { id: 'telegram:bot-1', ownerId: OWNER, agentId: 'agent-1', kind: 'telegram', channelId: 'bot-1', secretHashHex: 'hash', botToken: 'x', status: 'invalid_token', createdAt: AT, updatedAt: AT });
    expect(await deliverChannelReply(store, only(sender), input)).toMatchObject({ status: 'failed', failure: { kind: 'token_invalid' } });
    expect(sender.calls).toHaveLength(0);
  });

  it('skips conversations without a channel origin, items that are not replies and items that are gone', async () => {
    await store.put('conversations', makeConversation('cvn-plain', undefined));
    await store.put('items', { id: 'itm-user-1', conversationId: 'cvn-plain', type: 'user_message', authorId: OWNER, text: 'hi', attachments: [], mentions: [], at: AT });
    expect(await deliverChannelReply(store, only(sender), { ownerId: OWNER, conversationId: 'cvn-plain', itemId: 'itm-user-1' })).toEqual({ status: 'skipped' });
    expect(await deliverChannelReply(store, only(sender), { ownerId: OWNER, conversationId: 'cvn-plain', itemId: 'missing' })).toEqual({ status: 'skipped' });
    expect(sender.calls).toHaveLength(0);
  });
});
