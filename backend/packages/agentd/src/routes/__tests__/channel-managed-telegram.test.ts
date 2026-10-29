/**
 * CH7 Telegram managed bots: the creation link, the managed_bot update, auto-binding, expiry. Telegram is a fake fetch.
 * stored only sealed or hashed), opens the bind link, and from then on only their own DM is trusted.
 * Telegram is a fake fetch; nothing touches the network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { ChannelRow, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import { appDetailSchema, installAppResponseSchema, type Agent } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import { handleManagerUpdate } from '../../channels/telegram/managed.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-19T00:00:00.000Z';
const MANAGER = '999:manager-token';
const CREATED_TOKEN = '555:created-bot-token';

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

describe('telegram managed bots', () => {
  let app: Hono;
  let store: Store;
  let calls: Array<{ token: string; method: string; body: Record<string, unknown> }>;
  let tokenFails = false;

  const fakeTelegram: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const [, token, method] = /bot([^/]+)\/(\w+)$/.exec(url) ?? [];
    calls.push({ token: token ?? '', method: method ?? '', body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown> });
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 9, is_bot: true, username: token === MANAGER ? 'JunoManagerBot' : 'x' } });
    if (method === 'getManagedBotToken') {
      return tokenFails ? Response.json({ ok: false, description: 'nope' }, { status: 400 }) : Response.json({ ok: true, result: CREATED_TOKEN });
    }
    return Response.json({ ok: true, result: true });
  };

  const connect = (body: unknown): Promise<Response> =>
    Promise.resolve(app.request('/v1/apps/telegram/install', { method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ ...(body as Record<string, unknown>), agentId: 'agent-1' }) }));
  const detail = async () => appDetailSchema.parse(await (await app.request('/v1/apps/telegram', { headers: ownerHeaders(OWNER) })).json());
  const poll = async (id: string) => {
    const found = (await detail()).pending.find((pending) => pending.id === id);
    if (found === undefined) throw new Error('no such pending install ' + id);
    return found;
  };
  const managedUpdate = (username: string): unknown => ({ update_id: 1, managed_bot: { user: { id: 4242, first_name: 'Owner' }, bot: { id: 777, is_bot: true, username } } });

  beforeEach(async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 3).toString('base64'));
    vi.stubEnv('CHANNELS_PUBLIC_URL', '');
    vi.stubEnv('TELEGRAM_MANAGER_BOT_TOKEN', MANAGER);
    calls = [];
    tokenFails = false;
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    app = createTestApp({ store, bus: mem.eventBus, enqueuer: new RecordingEnqueuer(), channelFetch: fakeTelegram });
    await store.put('agents', makeAgent('agent-1'));
    return () => { vi.unstubAllEnvs(); };
  });

  it('is unavailable without a manager bot token', async () => {
    vi.stubEnv('TELEGRAM_MANAGER_BOT_TOKEN', '');
    const res = await connect({ mode: 'managed' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MANAGED_BOTS_UNAVAILABLE');
  });

  it('returns the creation link, then connects the bot and binds the creator on managed_bot', async () => {
    const res = await connect({ mode: 'managed', suggestedUsername: 'juno_helper_bot' });
    expect(res.status).toBe(202);
    const body = installAppResponseSchema.parse(await res.json());
    expect(body.openUrl).toBe('https://t.me/newbot/JunoManagerBot/juno_helper_bot?name=Agent%20agent-1');
    const id = body.pending?.id ?? '';
    expect((await poll(id)).status).toBe('pending');

    await handleManagerUpdate({ store, channelFetch: fakeTelegram }, MANAGER, managedUpdate('Juno_Helper_Bot'));
    const tokenCall = calls.find((call) => call.method === 'getManagedBotToken');
    expect(tokenCall).toMatchObject({ token: MANAGER, body: { user_id: 777 } });
    const row = await store.get('channels', 'telegram:Juno_Helper_Bot');
    expect(row).toMatchObject({ agentId: 'agent-1', ownerExternalId: '4242' });
    expect(decryptSecret(row?.botToken ?? '')).toBe(CREATED_TOKEN);
    expect((await poll(id)).status).toBe('connected');
    // A pending request is not an installation: only the bot itself is.
    expect((await detail()).installations).toMatchObject([{ id: 'telegram:Juno_Helper_Bot', label: '@Juno_Helper_Bot', bound: true, agentId: 'agent-1' }]);
  });

  it('ignores a bot nobody asked for, keeps the request pending, and expires it', async () => {
    const body = installAppResponseSchema.parse(await (await connect({ mode: 'managed', suggestedUsername: 'juno_helper_bot' })).json());
    const id = body.pending?.id ?? '';
    await handleManagerUpdate({ store, channelFetch: fakeTelegram }, MANAGER, managedUpdate('someone_elses_bot'));
    expect(await store.get('channels', 'telegram:someone_elses_bot')).toBeNull();
    expect(calls.some((call) => call.method === 'getManagedBotToken')).toBe(false);
    expect((await poll(id)).status).toBe('pending');
    const stored = await store.get('channels', 'pending:' + id);
    await store.put('channels', { ...(stored as ChannelRow), pending: { ...(stored?.pending as NonNullable<ChannelRow['pending']>), expiresAt: '2020-01-01T00:00:00.000Z' } });
    expect((await poll(id)).status).toBe('expired');
    // Too late: an expired request no longer creates a channel.
    await handleManagerUpdate({ store, channelFetch: fakeTelegram }, MANAGER, managedUpdate('juno_helper_bot'));
    expect(await store.get('channels', 'telegram:juno_helper_bot')).toBeNull();
  });

  it('marks the request failed when Telegram will not hand over the token, and rejects bad usernames', async () => {
    expect((await connect({ mode: 'managed', suggestedUsername: 'nope' })).status).toBe(400);
    const body = installAppResponseSchema.parse(await (await connect({ mode: 'managed', suggestedUsername: 'juno_helper_bot' })).json());
    expect((await connect({ mode: 'managed', suggestedUsername: 'JUNO_helper_bot' })).status).toBe(409);
    tokenFails = true;
    await handleManagerUpdate({ store, channelFetch: fakeTelegram }, MANAGER, managedUpdate('juno_helper_bot'));
    expect((await poll(body.pending?.id ?? '')).status).toBe('failed');
    expect(await store.get('channels', 'telegram:juno_helper_bot')).toBeNull();
  });
});
