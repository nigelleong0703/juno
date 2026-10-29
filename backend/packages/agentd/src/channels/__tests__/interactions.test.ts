/**
 * A tap on a platform button: the option is admitted as the user's message (or the request is decided), the original
 * message is rewritten so it cannot be tapped twice, and a decision from anyone but the bound owner is refused.
 * Platform calls go to a fake fetch; nothing touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import type { Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { channelConversationId, type AdmitDeps } from '../../routes/channels.js';
import { testChannels, withDefaultOwner } from '../../__tests__/test-app.js';
import { answerChannelClick, handleChannelClick } from '../interactions.js';
import { deliverChannelRequest, type ChannelSender } from '../delivery.js';

const OWNER = 'owner-1';
const OWNER_EXT = 'ext-owner';
const AT = '2026-10-19T00:00:00.000Z';

interface Call { url: string; body: Record<string, unknown> }

describe('channel button taps', () => {
  let store: Store;
  let wakes: WakeEvent[];
  let calls: Call[];
  let deps: AdmitDeps;

  const enqueuer = (): Enqueuer => ({
    enqueue: async (wake) => { wakes.push(wake); return { accepted: true }; },
    stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined,
  });

  async function setup(kind: string, channelId: string, chatId: string): Promise<string> {
    await store.put('agents', { id: 'agent-1', name: 'A', createdBy: OWNER, sharing: { publishedToTeam: false } } as never);
    await store.put('channels', {
      id: kind + ':' + channelId, ownerId: OWNER, agentId: 'agent-1', kind, channelId, secretHashHex: 'x',
      ownerExternalId: OWNER_EXT, botToken: encryptSecret('bot-token'), createdAt: AT, updatedAt: AT,
    });
    const conversationId = channelConversationId(OWNER, kind, channelId, chatId);
    await store.put('conversations', {
      id: conversationId, kind: 'direct', agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT,
      ownerId: OWNER, channel: { kind, channelId, threadId: chatId, chatId },
    } as never);
    await store.put('items', {
      id: 'itm_q', conversationId, type: 'agent_message', agentId: 'agent-1', markdown: 'Ready?', citations: [], at: AT,
      ui: { version: 1, blocks: [{ type: 'replies', options: ['Yes', 'No'] }] },
    });
    return conversationId;
  }

  async function putRequest(conversationId: string, id: string, kind: 'approval' | 'question'): Promise<void> {
    const payload = kind === 'approval'
      ? { kind: 'approval', action: 'Send email', why: 'asked' }
      : { kind: 'question', ui: { version: 1, blocks: [{ type: 'choices', id: 'pick', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }] } };
    await store.put('requests', { id, status: 'pending', agentId: 'agent-1', conversationId, kind, title: 'T', summary: 'S', payload, createdAt: new Date().toISOString() } as never);
  }

  const userTexts = async (): Promise<string[]> =>
    (await store.list('items', { limit: 50 })).items.flatMap((item) => (item.type === 'user_message' ? [item.text] : []));

  beforeEach(() => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 9).toString('base64'));
    store = withDefaultOwner(createMemoryStore(), OWNER);
    wakes = [];
    calls = [];
    const channelFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return Response.json({ ok: true });
    };
    deps = { store, enqueuer: enqueuer(), channels: testChannels, channelFetch };
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('Telegram: a quick reply is admitted as the user message linked to the item; the keyboard is replaced', async () => {
    await setup('telegram', 'bot-1', 'chat-1');
    const update = { update_id: 1, callback_query: { id: 'cq1', data: 'jn:i:itm_q:1', from: { id: Number('1'), first_name: 'Robin' }, message: { message_id: 42, chat: { id: 1 } } } };
    // The bound owner is Telegram user "ext-owner"; rebind to the tapper for this case.
    await store.patch('channels', 'telegram:bot-1', { ownerExternalId: '1' });
    expect((await answerChannelClick(deps, OWNER, 'telegram', 'bot-1', update)).handled).toBe(true);
    expect(await userTexts()).toEqual(['No']);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({ text: 'No', replyToItemId: 'itm_q', speakerRole: 'owner' });
    expect(calls.map((call) => call.url.split('/').pop())).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(calls[1]?.body).toMatchObject({ chat_id: '1', message_id: 42, reply_markup: { inline_keyboard: [[{ text: '✓ No' }]] } });
    // A second, different tap on the same message is refused and shown as an alert.
    calls.length = 0;
    await answerChannelClick(deps, OWNER, 'telegram', 'bot-1', { ...update, update_id: 2, callback_query: { ...update.callback_query, id: 'cq2', data: 'jn:i:itm_q:0' } });
    expect(await userTexts()).toEqual(['No']);
    expect(calls[0]?.body).toMatchObject({ callback_query_id: 'cq2', show_alert: true });
  });

  it('Slack: the block action is admitted and the original message rewritten without its buttons', async () => {
    await setup('slack', 'T1-UBOT', 'D1');
    const payload = JSON.stringify({
      type: 'block_actions', user: { id: OWNER_EXT, name: 'robin' }, channel: { id: 'D1' },
      message: { ts: '9.9', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Ready?' } }, { type: 'actions', elements: [] }] },
      actions: [{ action_id: 'jn:i:itm_q:0', value: 'jn:i:itm_q:0' }], response_url: 'https://hooks.slack.com/actions/x',
    });
    expect((await answerChannelClick(deps, OWNER, 'slack', 'T1-UBOT', payload)).handled).toBe(true);
    expect(await userTexts()).toEqual(['Yes']);
    const update = calls.find((call) => call.url.endsWith('chat.update'));
    expect(update?.body).toMatchObject({ channel: 'D1', ts: '9.9' });
    expect(update?.body['blocks']).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Ready?' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '✓ Yes' }] },
    ]);
  });

  it('Discord: the component tap is admitted and answered with an updated message (type 7, disabled button)', async () => {
    await setup('discord', 'bot-d', 'ch-1');
    const data = { id: 'i1', token: 'tok', type: 3, data: { custom_id: 'jn:i:itm_q:0' }, user: { id: OWNER_EXT, username: 'robin' } };
    expect((await answerChannelClick(deps, OWNER, 'discord', 'bot-d', data)).handled).toBe(true);
    expect(await userTexts()).toEqual(['Yes']);
    // The working mark (a reaction) goes out in the background, so the callback is found by its URL, not its place.
    const callback = calls.find((call) => call.url === 'https://discord.com/api/v10/interactions/i1/tok/callback');
    expect(callback?.body).toEqual({ type: 7, data: { components: [{ type: 1, components: [{ type: 2, style: 2, label: '✓ Yes', custom_id: 'jn:x', disabled: true }] }] } });
    expect((await answerChannelClick(deps, OWNER, 'discord', 'bot-d', { ...data, type: 2 })).handled).toBe(false);
  });

  it('Feishu: the card action is admitted and answered with a redrawn card and a toast', async () => {
    await setup('feishu', 'cli_app', 'oc_chat');
    const event = { operator: { open_id: OWNER_EXT }, action: { value: { t: 'jn:i:itm_q:1' } } };
    const { response } = await answerChannelClick(deps, OWNER, 'feishu', 'cli_app', event);
    expect(await userTexts()).toEqual(['No']);
    expect(response).toMatchObject({ toast: { type: 'success', content: 'No' }, card: { type: 'raw' } });
    expect(JSON.stringify(response)).toContain('✓ No');
    expect(JSON.stringify(response)).not.toContain('"action"');
    expect((await answerChannelClick(deps, OWNER, 'feishu', 'cli_app', { action: { value: { t: 'other' } } })).handled).toBe(false);
  });

  it('an approval can only be decided by the bound owner; anyone else changes nothing', async () => {
    const conversationId = await setup('slack', 'T1-UBOT', 'C1');
    await putRequest(conversationId, 'req_ok', 'approval');
    const stranger = await handleChannelClick(deps, OWNER, 'slack', 'T1-UBOT', { token: 'jn:a:req_ok:0', from: { id: 'someone-else', name: 'Eve' } });
    expect(stranger).toEqual({ status: 'not-owner' });
    expect((await store.get('requests', 'req_ok'))?.status).toBe('pending');
    const owner = await handleChannelClick(deps, OWNER, 'slack', 'T1-UBOT', { token: 'jn:a:req_ok:0', from: { id: OWNER_EXT, name: 'Me' } });
    expect(owner).toEqual({ status: 'done', label: 'Approved' });
    expect((await store.get('requests', 'req_ok'))?.status).toBe('approved');
    expect(wakes.some((wake) => wake.kind === 'request_resolved')).toBe(true);
    // Already decided: a late second tap is stale, not a second decision.
    expect((await handleChannelClick(deps, OWNER, 'slack', 'T1-UBOT', { token: 'jn:a:req_ok:1', from: { id: OWNER_EXT, name: 'Me' } })).status).toBe('stale');
    expect((await store.get('requests', 'req_ok'))?.status).toBe('approved');
  });

  it('Slack: a stranger tapping Approve gets an ephemeral note and the message is left alone', async () => {
    const conversationId = await setup('slack', 'T1-UBOT', 'C1');
    await putRequest(conversationId, 'req_x', 'approval');
    await answerChannelClick(deps, OWNER, 'slack', 'T1-UBOT', JSON.stringify({ type: 'block_actions', user: { id: 'eve' }, actions: [{ action_id: 'jn:a:req_x:0' }], response_url: 'https://hooks.slack.com/r', channel: { id: 'C1' }, message: { ts: '1.1' } }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://hooks.slack.com/r', body: { response_type: 'ephemeral', text: 'Only the owner can decide this.' } });
    expect((await store.get('requests', 'req_x'))?.status).toBe('pending');
  });

  it('a question option answers the request through the app path and reaches the agent as the user message', async () => {
    const conversationId = await setup('telegram', 'bot-1', 'chat-1');
    await putRequest(conversationId, 'req_q', 'question');
    const outcome = await handleChannelClick(deps, OWNER, 'telegram', 'bot-1', { token: 'jn:q:req_q:1', from: { id: OWNER_EXT, name: 'Me' } });
    expect(outcome).toEqual({ status: 'done', label: 'Beta' });
    const stored = await store.get('requests', 'req_q');
    expect(stored?.status).toBe('answered');
    expect(stored?.payload).toMatchObject({ answers: { pick: 'b' } });
    expect(await userTexts()).toContain('Beta');
  });

  it('a button from another channel or an unknown token is stale', async () => {
    await setup('telegram', 'bot-1', 'chat-1');
    await store.put('channels', { id: 'telegram:bot-2', ownerId: OWNER, agentId: 'agent-1', kind: 'telegram', channelId: 'bot-2', secretHashHex: 'x', createdAt: AT, updatedAt: AT });
    expect((await handleChannelClick(deps, OWNER, 'telegram', 'bot-2', { token: 'jn:i:itm_q:0', from: { id: OWNER_EXT, name: '' } })).status).toBe('stale');
    expect((await handleChannelClick(deps, OWNER, 'telegram', 'bot-1', { token: 'garbage', from: { id: OWNER_EXT, name: '' } })).status).toBe('stale');
  });

  it('delivers a pending question as buttons through the sender, once', async () => {
    const conversationId = await setup('telegram', 'bot-1', 'chat-1');
    await putRequest(conversationId, 'req_d', 'question');
    const sent: Array<{ text: string; labels: string[] }> = [];
    const sender: ChannelSender = {
      sendText: async () => ({ ok: true }),
      sendRich: async (_target, rich) => { sent.push({ text: rich.text, labels: rich.buttons.map((button) => button.label) }); return { ok: true, externalId: '1' }; },
    };
    const input = { ownerId: OWNER, conversationId, requestId: 'req_d' };
    expect(await deliverChannelRequest(store, (kind) => (kind === 'telegram' ? sender : undefined), input)).toEqual({ status: 'sent', externalId: '1' });
    expect(await deliverChannelRequest(store, (kind) => (kind === 'telegram' ? sender : undefined), input)).toEqual({ status: 'duplicate' });
    expect(sent).toEqual([{ text: expect.any(String), labels: ['Alpha', 'Beta'] }]);
  });
});
