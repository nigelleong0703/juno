/**
 * Feishu / Lark channel: connect (credentials checked, secret sealed, owner found by email), the token cache, the
 * sender, and the long-connection runner admitting one event. A fake fetch and a fake WS factory; no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { ChannelRow, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import type { Agent } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, testChannels, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import { clearFeishuTokenCache, createFeishuSender, parseFeishuMessage } from '@agent-desktop/channels/feishu/api';
import { createFeishuRunner } from '../../channels/feishu/ws.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-19T00:00:00.000Z';
const APP_ID = 'cli_a1';
const SECRET = 'app-secret';
const BOT = 'ou_bot';

function makeAgent(id: string): Agent {
  return {
    id, name: 'Agent ' + id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent',
    status: 'idle', section: 'Inbox', pinned: false, lastActivity: 'Just created', unreadCount: 0,
    model: {
      planner: { provider: 'openai', model: 'gpt-4' },
      computer: { provider: 'openai', model: 'gpt-4-vision' },
      fast: { provider: 'openai', model: 'gpt-3.5-turbo' },
    },
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt: AT, updatedAt: AT,
  };
}

class RecordingEnqueuer implements Enqueuer {
  wakes: WakeEvent[] = [];
  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string }> {
    this.wakes.push(event);
    return { accepted: true };
  }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

interface Call { url: string; body: Record<string, unknown>; auth: string | null }

function makeFeishu(opts: { messageCode?: number; invalidOnce?: boolean; emailOpenId?: string } = {}) {
  const calls: Call[] = [];
  let invalidLeft = opts.invalidOnce === true ? 1 : 0;
  let tokens = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url, body, auth });
    if (url.endsWith('/tenant_access_token/internal')) {
      if (body['app_secret'] !== SECRET) return Response.json({ code: 10003, msg: 'invalid param' });
      tokens += 1;
      return Response.json({ code: 0, tenant_access_token: 't-' + String(tokens), expire: 7200 });
    }
    if (invalidLeft > 0) { invalidLeft -= 1; return Response.json({ code: 99991663, msg: 'invalid access token' }); }
    if (url.includes('/contact/v3/users/batch_get_id')) {
      const emails = body['emails'] as string[];
      return Response.json({ code: 0, data: { user_list: [opts.emailOpenId === undefined ? { email: emails[0] } : { email: emails[0], user_id: opts.emailOpenId }] } });
    }
    if (url.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: BOT, app_name: 'Juno' } });
    return Response.json({ code: opts.messageCode ?? 0, msg: opts.messageCode ? 'no permission' : 'ok', data: { message_id: 'om_sent' } });
  };
  return { fetchFn, calls };
}

function event(over: { chat_type?: string; message_type?: string; sender_type?: string; text?: string; mentions?: unknown[]; root_id?: string } = {}): unknown {
  return {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: over.sender_type ?? 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: over.chat_type ?? 'p2p',
      message_type: over.message_type ?? 'text',
      content: JSON.stringify({ text: over.text ?? 'hello' }),
      ...(over.mentions === undefined ? {} : { mentions: over.mentions }),
      ...(over.root_id === undefined ? {} : { root_id: over.root_id }),
    },
  };
}

describe('parseFeishuMessage', () => {
  it('maps a p2p text message', () => {
    expect(parseFeishuMessage(event(), BOT)).toEqual({
      chatId: 'oc_1', chatType: 'private', threadId: 'oc_1', externalMessageId: 'om_1', from: { id: 'ou_user', name: '' }, text: 'hello',
    });
  });
  it('keeps a group message that mentions the bot and strips the placeholder', () => {
    const e = parseFeishuMessage(event({ chat_type: 'group', text: '@_user_1 hi @_user_2', mentions: [{ key: '@_user_1', id: { open_id: BOT } }, { key: '@_user_2', id: { open_id: 'ou_x' } }] }), BOT);
    expect(e?.chatType).toBe('group');
    expect(e?.text).toBe('hi @_user_2');
  });
  it('ignores group chatter without a bot mention, non-text and app senders', () => {
    expect(parseFeishuMessage(event({ chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'ou_x' } }] }), BOT)).toBeNull();
    expect(parseFeishuMessage(event({ chat_type: 'group' }), BOT)).toBeNull();
    expect(parseFeishuMessage(event({ message_type: 'image' }), BOT)).toBeNull();
    expect(parseFeishuMessage(event({ sender_type: 'app' }), BOT)).toBeNull();
  });
  it('threads on the root message', () => {
    expect(parseFeishuMessage(event({ root_id: 'om_root' }), BOT)?.threadId).toBe('oc_1:om_root');
  });
});

describe('feishu channel', () => {
  let app: Hono;
  let store: Store;
  let enqueuer: RecordingEnqueuer;
  let feishu: ReturnType<typeof makeFeishu>;

  beforeEach(async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 3).toString('base64'));
    clearFeishuTokenCache();
    feishu = makeFeishu();
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer, channelFetch: feishu.fetchFn });
    await store.put('agents', makeAgent('agent-1'));
    return () => { vi.unstubAllEnvs(); };
  });

  it('a pasted App ID and secret are refused: apps are created by scanning', async () => {
    const res = await Promise.resolve(app.request('/v1/apps/feishu/install', {
      method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ appId: APP_ID, appSecret: SECRET, agentId: 'agent-1' }),
    }));
    expect(res.status).toBe(400);
    expect(await store.get('channels', 'feishu:' + APP_ID)).toBeNull();
  });

  it('holds the first DM of an unbound app for the owner to confirm', async () => {
    const none = makeFeishu();
    const now = new Date().toISOString();
    await store.put('channels', { id: 'feishu:' + APP_ID, ownerId: OWNER, agentId: 'agent-1', kind: 'feishu', channelId: APP_ID, domain: 'feishu', secretHashHex: 'x', botToken: encryptSecret(SECRET), status: 'active', createdAt: now, updatedAt: now });
    const res = await app.request('/v1/channels/feishu/' + APP_ID + '/events', {
      method: 'POST', headers: ownerHeaders(OWNER, true),
      body: JSON.stringify(parseFeishuMessage(event({ text: 'hello' }), BOT)),
    });
    expect(res.status).toBe(200);
    expect(enqueuer.wakes).toHaveLength(0);
    expect(none.calls.some((c) => c.url.includes('/im/v1/messages'))).toBe(false);
  });

  it('caches the tenant token and refreshes once on an invalid-token answer', async () => {
    const sender = createFeishuSender(feishu.fetchFn);
    const channel = { botToken: SECRET, channelId: APP_ID } as ChannelRow;
    await sender.sendText({ channel, chatId: 'oc_1', threadId: 'oc_1' }, 'a');
    await sender.sendText({ channel, chatId: 'oc_1', threadId: 'oc_1' }, 'b');
    expect(feishu.calls.filter((c) => c.url.endsWith('/tenant_access_token/internal'))).toHaveLength(1);
    const flaky = makeFeishu({ invalidOnce: true });
    clearFeishuTokenCache();
    const result = await createFeishuSender(flaky.fetchFn).sendText({ channel, chatId: 'oc_1', threadId: 'oc_1' }, 'c');
    expect(result.ok).toBe(true);
    expect(flaky.calls.filter((c) => c.url.endsWith('/tenant_access_token/internal'))).toHaveLength(2);
  });

  it('sends to the chat, or replies inside a thread, and fails on a non-zero code', async () => {
    const channel = { botToken: SECRET, channelId: APP_ID } as ChannelRow;
    const sender = createFeishuSender(feishu.fetchFn);
    expect(await sender.sendText({ channel, chatId: 'oc_1', threadId: 'oc_1' }, 'hi')).toEqual({ ok: true, externalId: 'om_sent' });
    const plain = feishu.calls[feishu.calls.length - 1];
    expect(plain?.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id');
    expect(plain?.body).toEqual({ receive_id: 'oc_1', msg_type: 'text', content: JSON.stringify({ text: 'hi' }) });
    await sender.sendText({ channel, chatId: 'oc_1', threadId: 'oc_1:om_root' }, 'yo');
    expect(feishu.calls[feishu.calls.length - 1]?.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_root/reply');
    const failing = makeFeishu({ messageCode: 230001 });
    clearFeishuTokenCache();
    const res = await createFeishuSender(failing.fetchFn).sendText({ channel, chatId: 'oc_1', threadId: 'oc_1' }, 'x');
    expect(res.ok).toBe(false);
  });

  it('runner opens one connection per row and admits a dispatched event', async () => {
    const row: ChannelRow = {
      id: 'feishu:' + APP_ID, ownerId: OWNER, agentId: 'agent-1', kind: 'feishu', channelId: APP_ID, domain: 'feishu',
      secretHashHex: 'h', botToken: encryptSecret(SECRET), status: 'active', createdAt: AT, updatedAt: AT,
    };
    await store.put('channels', { ...row, ownerExternalId: 'ou_user' });
    const opened: Array<{ appId: string; send: (e: unknown) => Promise<void>; closed: boolean }> = [];
    const runner = createFeishuRunner((creds, onMessage) => {
      const entry = { appId: creds.appId, send: onMessage, closed: false };
      opened.push(entry);
      return { close: () => { entry.closed = true; } };
    });
    const stop = runner.start({ store, enqueuer, channels: testChannels, channelFetch: feishu.fetchFn });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    await opened[0]?.send(event({ text: 'ping' }));
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]?.payload).toMatchObject({ text: 'ping', channelKind: 'feishu' });
    stop();
    await vi.waitFor(() => expect(opened[0]?.closed).toBe(true));
  });
});
