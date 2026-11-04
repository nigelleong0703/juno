import { aguiInput } from '../../../../../tests/agui-input.js';
/**
 * Every platform chat is its own conversation: the owner's DM ("Slack · Agent"), groups ("#name · Slack"), strangers. A reply follows
 * the chat of the message that woke the run; channel conversations are read-only in the app, and the app's main chat (no channel
 * meta) delivers nothing to channels.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import { replyOriginOf } from 'juno-agent/modules/channel-origin';
import { isNewOwnerChat } from 'juno-agent/modules/onboarding';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import { postedReceipt } from '../../channels/posted.js';
import { deliverChannelReply, deliverChannelRequest, type ChannelSender } from '../../channels/delivery.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-19T00:00:00.000Z';
const CID = 'sabcdefghijkl';

function makeAgent(id: string): Agent {
  return {
    id, name: 'Agent ' + id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent',
    status: 'idle', section: 'Inbox', pinned: false, lastActivity: 'Just created', unreadCount: 0,
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt: AT, updatedAt: AT,
  } as Agent;
}

describe('unified owner conversation', () => {
  let app: Hono;
  let store: Store;
  let wakes: WakeEvent[];
  let sent: Array<{ chatId: string; threadId: string; text: string }>;

  const enqueuer: Enqueuer = {
    enqueue: async (wake) => { wakes.push(wake); return { accepted: true }; },
    stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined,
  };
  const sender: ChannelSender = {
    sendText: async (target, text) => { sent.push({ chatId: target.chatId, threadId: target.threadId, text }); return { ok: true, externalId: 'x' }; },
  };
  const fakeSlack: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('conversations.info')) return Response.json({ ok: true, channel: { name: 'general' } });
    return Response.json({ ok: false, error: 'unknown_method' });
  };

  const slackEvent = (event: Record<string, unknown>) =>
    Promise.resolve(app.request('/v1/channels/slack/' + CID + '/events', {
      method: 'POST', headers: ownerHeaders(OWNER, true),
      body: JSON.stringify({ type: 'event_callback', event_id: 'Ev' + String(Math.random()), event: { ts: '100.1', text: 'hi', channel: 'D1', ...event } }),
    }));

  beforeEach(async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 5).toString('base64'));
    wakes = [];
    sent = [];
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    app = createTestApp({ store, bus: mem.eventBus, enqueuer, channelFetch: fakeSlack });
    await store.put('agents', makeAgent('agent-1'));
    await store.put('channels', {
      id: 'slack:' + CID, ownerId: OWNER, agentId: 'agent-1', kind: 'slack', channelId: CID, secretHashHex: 'x', botToken: encryptSecret('xoxb-1'),
      botUserId: 'UBOT', ownerExternalId: 'UOWNER', status: 'active', createdAt: AT, updatedAt: AT,
    });
    // The chat the app shows.
    const appChat: Conversation & { ownerId: string } = { id: 'cvn-app', kind: 'direct', agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT, ownerId: OWNER };
    await store.put('conversations', appChat);
    return () => { vi.unstubAllEnvs(); };
  });

  const appSend = (conversationId: string, text: string) =>
    Promise.resolve(app.request('/v1/conversations/' + conversationId + '/runs', { method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify(aguiInput('/v1/conversations/' + conversationId + '/runs', { text })) }));

  it('gives the owner\'s Slack DM its own conversation, reused by the next message, and keeps the app chat app-only', async () => {
    expect((await slackEvent({ type: 'message', channel_type: 'im', user: 'UOWNER', text: 'from slack' })).status).toBe(202);
    expect((await slackEvent({ type: 'message', channel_type: 'im', user: 'UOWNER', text: 'again', ts: '100.2' })).status).toBe(202);
    const wake = wakes[0] as WakeEvent;
    expect(wake.conversationId).not.toBe('cvn-app');
    expect(wakes[1]?.conversationId).toBe(wake.conversationId);
    expect(wake.trusted).toBe(true);
    const convs = (await store.list('conversations', { limit: 50 })).items;
    expect(convs).toHaveLength(2);
    const dm = convs.find((conv) => conv.id === wake.conversationId);
    expect(dm).toMatchObject({ kind: 'direct', title: 'Slack · Agent agent-1', channel: { kind: 'slack', channelId: CID, chatId: 'D1' } });
    expect((await store.list('items', { where: { conversationId: 'cvn-app' }, limit: 20 })).items).toHaveLength(0);
    const items = (await store.list('items', { where: { conversationId: wake.conversationId }, limit: 20 })).items;
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.type === 'user_message' && item.text === 'from slack')).toMatchObject({ type: 'user_message', text: 'from slack', source: { kind: 'slack', channelId: CID, chatId: 'D1', chatType: 'private' }, channelSender: { role: 'owner' } });
  });

  it('keeps the app main chat app-only: its wake has no origin and nothing reaches a platform', async () => {
    expect((await appSend('cvn-app', 'app only')).status).toBe(202);
    expect(replyOriginOf([wakes[0] as WakeEvent])).toBeUndefined();
    await store.put('items', { id: 'itm-a2', conversationId: 'cvn-app', type: 'agent_message', at: AT, agentId: 'agent-1', markdown: 'app only', citations: [] });
    expect(await deliverChannelReply(store, (kind) => (kind === 'slack' ? sender : undefined), { ownerId: OWNER, conversationId: 'cvn-app', itemId: 'itm-a2' })).toEqual({ status: 'skipped' });
    expect(sent).toHaveLength(0);
  });

  it('asks a question where the user asked, and not in a chat the app started', async () => {
    await slackEvent({ type: 'message', channel_type: 'im', user: 'UOWNER', text: 'plan it' });
    const dmId = (wakes[0] as WakeEvent).conversationId as string;
    const question = { id: 'req-1', status: 'pending', agentId: 'agent-1', conversationId: dmId, kind: 'question', title: 'T', summary: 'S', createdAt: new Date(Date.now() + 1000).toISOString(),
      payload: { kind: 'question', ui: { version: 1, blocks: [{ type: 'choices', id: 'p', options: [{ id: 'a', label: 'Alpha' }] }] } } };
    await store.put('requests', question as never);
    expect(await deliverChannelRequest(store, (kind) => (kind === 'slack' ? sender : undefined), { ownerId: OWNER, conversationId: dmId, requestId: 'req-1' })).toMatchObject({ status: 'sent' });
    expect(sent[0]?.chatId).toBe('D1');
  });

  it('keeps groups and strangers in their own conversations with a readable title', async () => {
    await slackEvent({ type: 'app_mention', channel: 'C9', user: 'UOWNER', text: '<@UBOT> group question' });
    await slackEvent({ type: 'message', channel_type: 'im', channel: 'D7', user: 'USTRANGER', text: 'hello', ts: '200.1' });
    const convs = (await store.list('conversations', { limit: 50 })).items;
    expect(convs).toHaveLength(3);
    const group = convs.find((conv) => conv.kind === 'room');
    expect(group?.title).toBe('#general · Slack');
    const stranger = convs.find((conv) => conv.kind === 'direct' && conv.id !== 'cvn-app');
    expect(stranger?.id).not.toBe('cvn-app');
    expect(wakes.map((wake) => wake.conversationId)).not.toContain('cvn-app');
    expect((await store.list('items', { where: { conversationId: 'cvn-app' }, limit: 20 })).items).toHaveLength(0);
    // A group reply is delivered to the group by its replyTo.
    const replyTo = replyOriginOf([wakes[0] as WakeEvent]);
    expect(replyTo).toMatchObject({ chatId: 'C9', chatType: 'group' });
  });

  it('creates the owner\'s platform chat when the app has none, and never treats it as the sign-up chat', async () => {
    const mem = createMemoryStore();
    const fresh = withDefaultOwner(mem, OWNER);
    const freshApp = createTestApp({ store: fresh, bus: mem.eventBus, enqueuer, channelFetch: fakeSlack });
    await fresh.put('agents', makeAgent('agent-1'));
    await fresh.put('channels', {
      id: 'slack:' + CID, ownerId: OWNER, agentId: 'agent-1', kind: 'slack', channelId: CID, secretHashHex: 'x', botToken: encryptSecret('xoxb-1'),
      botUserId: 'UBOT', ownerExternalId: 'UOWNER', status: 'active', createdAt: AT, updatedAt: AT,
    });
    const post = (ts: string) => freshApp.request('/v1/channels/slack/' + CID + '/events', {
      method: 'POST', headers: ownerHeaders(OWNER, true),
      body: JSON.stringify({ type: 'event_callback', event_id: 'E' + ts, event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'UOWNER', text: 'hi', ts } }),
    });
    expect((await post('1.1')).status).toBe(202);
    expect((await post('2.2')).status).toBe(202);
    const convs = (await fresh.list('conversations', { limit: 50 })).items;
    expect(convs).toHaveLength(1);
    expect(convs[0]?.channel).toMatchObject({ kind: 'slack', chatId: 'D1' });
    expect(await isNewOwnerChat(fresh, OWNER, 'agent-1', convs[0]?.id ?? '')).toBe(false);
  });

  it('a reply in a thread under a message the agent posted itself answers the agent without a mention; under anyone else\'s message it is only observed', async () => {
    const reply = (parent: string, ts: string) => app.request('/v1/channels/slack/' + CID + '/events', {
      method: 'POST', headers: ownerHeaders(OWNER, true),
      body: JSON.stringify({ chatType: 'group', chatId: 'C7', threadId: 'C7:' + parent, externalMessageId: 'C7:' + ts, from: { id: 'U2', name: 'Bob' }, text: 'thanks, and the second one?', addressed: false }),
    });
    await store.put('eventReceipts', postedReceipt(OWNER, 'agent-1', 'slack:' + CID, 'C7', '55.5', AT) as never);
    expect((await reply('55.5', '56.1')).status).toBe(202);
    expect((await reply('77.7', '78.1')).status).toBe(202);
    expect(wakes.map((wake) => [wake.kind, wake.conversationId === wakes[0]?.conversationId])).toEqual([['room_mention', true], ['observed', false]]);
  });

  it('an approval someone else\'s ask raised never goes into the group: it reaches the owner\'s private chat (opened when the owner has none), where the Approve button decides it', async () => {
    await slackEvent({ type: 'app_mention', channel: 'C9', user: 'UALICE', text: '<@UBOT> please research CDNs' });
    const groupId = (wakes[0] as WakeEvent).conversationId as string;
    const approval = (id: string) => ({
      id, status: 'pending', agentId: 'agent-1', conversationId: groupId, kind: 'approval', title: 'Start a research task', summary: 'Alice asked in #general · Slack: start a task', createdAt: new Date(Date.now() + 1000).toISOString(),
      payload: { kind: 'approval', action: 'Start a task', target: 'child spawn', why: 'Alice asked in #general · Slack: start a task', askedBy: { name: 'Alice', where: '#general · Slack', kind: 'teammate' } },
    });
    await store.put('requests', approval('req-g1') as never);
    const senders = (kind: string) => (kind === 'slack' ? { ...sender, openDirect: async () => 'DOWNER' } : undefined);
    // No private chat with the owner yet: it is opened through the platform and remembered, and the card goes there.
    expect(await deliverChannelRequest(store, senders, { ownerId: OWNER, conversationId: groupId, requestId: 'req-g1' })).toMatchObject({ status: 'sent' });
    expect(sent.map((message) => message.chatId)).toEqual(['DOWNER']);
    expect(sent.some((message) => message.chatId === 'C9')).toBe(false);
    expect(await store.get('channels', 'slack:' + CID)).toMatchObject({ ownerChatId: 'DOWNER' });
    // Without a way to reach the owner it stays in the app.
    const lonely = withDefaultOwner(createMemoryStore(), OWNER);
    await lonely.put('agents', makeAgent('agent-1'));
    await lonely.put('channels', { id: 'slack:' + CID, ownerId: OWNER, agentId: 'agent-1', kind: 'slack', channelId: CID, secretHashHex: 'x', botToken: encryptSecret('xoxb-1'), botUserId: 'UBOT', status: 'active', createdAt: AT, updatedAt: AT });
    const meta = { kind: 'slack', channelId: CID, threadId: 'C9:1.1', chatId: 'C9' };
    await lonely.put('conversations', { id: 'cvn-g', kind: 'room', agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT, ownerId: OWNER, channel: meta } as never);
    await lonely.put('requests', { ...approval('req-g2'), conversationId: 'cvn-g' } as never);
    expect(await deliverChannelRequest(lonely, (kind) => (kind === 'slack' ? sender : undefined), { ownerId: OWNER, conversationId: 'cvn-g', requestId: 'req-g2' })).toEqual({ status: 'skipped' });
    expect(sent).toHaveLength(1);
  });

  it('keeps the owner\'s settings for a group on the channel row: speaking up and the categories a teammate may use; a conversation that is not a group has none', async () => {
    await slackEvent({ type: 'app_mention', channel: 'C9', user: 'UOWNER', text: '<@UBOT> hi' });
    const groupId = (wakes[0] as WakeEvent).conversationId as string;
    const get = () => app.request('/v1/conversations/' + groupId + '/group', { headers: ownerHeaders(OWNER, true) });
    expect(await (await get()).json()).toMatchObject({ platform: 'slack', speak: false, delegated: [], observes: true });
    const put = await app.request('/v1/conversations/' + groupId + '/group', { method: 'PUT', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ speak: true, delegated: ['speaking', 'speaking', 'committing'] }) });
    expect(await put.json()).toMatchObject({ speak: true, delegated: ['speaking', 'committing'] });
    expect(await (await get()).json()).toMatchObject({ speak: true });
    expect((await store.get('channels', 'slack:' + CID))?.groups?.['C9']).toMatchObject({ speak: true });
    expect((await app.request('/v1/conversations/cvn-app/group', { headers: ownerHeaders(OWNER, true) })).status).toBe(404);
    expect((await app.request('/v1/conversations/' + groupId + '/group', { method: 'PUT', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ delegated: ['sensitive'] }) })).status).toBe(400);
  });

  it('a group message nobody addressed is observed: stored (hidden conversation, observed item), counted by the digest, never a run; the mention that follows reads it', async () => {
    const post = (ts: string, extra: Record<string, unknown>, text = 'does anyone know the port?') => app.request('/v1/channels/slack/' + CID + '/events', {
      method: 'POST', headers: ownerHeaders(OWNER, true),
      body: JSON.stringify({ chatType: 'group', chatId: 'C7', threadId: 'C7:T1', externalMessageId: 'C7:' + ts, from: { id: 'U2', name: 'Bob' }, text, ...extra }),
    });
    expect((await post('1.1', { addressed: false })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await post('1.2', { addressed: false }, 'I think it is 8080')).status).toBe(202);
    // The conversation exists but is not a chat of the list until the agent is addressed in it; the wakes are the digest's counters.
    const hidden = (await store.list('conversations', { limit: 50 })).items.filter((conv) => conv.id !== 'cvn-app');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({ observedOnly: true });
    expect((await store.list('items', { where: { conversationId: hidden[0]?.id ?? '' }, limit: 10 })).items.map((item) => item.type === 'user_message' && item.observed)).toEqual([true, true]);
    expect(wakes.map((wake) => wake.kind)).toEqual(['observed', 'observed']);
    expect((await post('2.2', {}, 'which port, @Nova?')).status).toBe(202);
    expect(wakes[2]).toMatchObject({ kind: 'room_mention', payload: { observed: [{ who: 'Bob', text: 'does anyone know the port?' }, { who: 'Bob', text: 'I think it is 8080' }] } });
    expect(wakes[2]?.payload['addressed']).toBeUndefined();
    expect((await store.get('conversations', hidden[0]?.id ?? '')) as { observedOnly?: boolean } | null).toMatchObject({ observedOnly: false });
    // Read once: the next mention does not get them again.
    expect((await post('3.3', {}, 'thanks')).status).toBe(202);
    expect(wakes[3]?.payload['observed']).toBeUndefined();
  });
});
