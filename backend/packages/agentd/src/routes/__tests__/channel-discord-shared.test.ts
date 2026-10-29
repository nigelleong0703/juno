/**
 * The shared Juno Discord bot: the invite redirect makes an installation and a mentionable role per agent; messages are routed by
 * `mention_roles`; replies in a server channel go through a webhook that carries the agent's name and picture, DMs through the bot.
 * Discord is a fake fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import { installAppResponseSchema, type Agent } from '@agent-desktop/public-contracts';
import { replyOriginOf } from 'juno-agent/modules/channel-origin';
import { LIMITS } from 'juno-agent/contracts';
import { checkHop } from 'juno-agent/execution/harness/logic/guards';
import { recordRunHop } from 'juno-agent/execution/harness/services/chain-cost';
import { createTestApp, ownerHeaders, testChannels, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import { deliverChannelReply } from '../../channels/delivery.js';
import { admitSharedDiscordMessage } from '../../channels/discord/shared.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-19T00:00:00.000Z';

function makeAgent(id: string, name: string, createdAt: string): Agent {
  return {
    id, name, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent',
    status: 'idle', section: 'Inbox', pinned: false, lastActivity: 'Just created', unreadCount: 0,
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt, updatedAt: createdAt,
  } as Agent;
}

interface Call { method: string; path: string; auth: string | null; body: Record<string, unknown> }

describe('shared Discord bot', () => {
  let app: Hono;
  let store: Store;
  let wakes: WakeEvent[];
  let calls: Call[];
  let roles: number;
  let webhooksMade: number;

  const enqueuer: Enqueuer = {
    enqueue: async (wake) => { wakes.push(wake); return { accepted: true }; },
    stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined,
  };

  const fakeDiscord: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace('/api/v10', '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, path, auth: new Headers(init?.headers).get('authorization'), body });
    if (path === '/users/@me') return Response.json({ id: 'BOT' });
    if (path === '/guilds/G1' && method === 'GET') return Response.json({ id: 'G1', owner_id: 'UGUILDOWNER' });
    if (path === '/guilds/G1/audit-logs') return Response.json({ audit_log_entries: [{ target_id: 'BOT', user_id: 'UOWNER' }] });
    if (path === '/guilds/G1/roles' && method === 'POST') { roles += 1; return Response.json({ id: 'R' + String(roles) }); }
    if (path === '/channels/C1/webhooks') { webhooksMade += 1; return Response.json({ id: 'W1', token: 'wtok' }); }
    if (path === '/webhooks/W1/wtok') return Response.json({ id: 'hook-msg' });
    if (path.endsWith('/messages')) return Response.json({ id: 'bot-msg' });
    return Response.json({ message: 'unknown' }, { status: 404 });
  };

  /** Adds the Juno bot to a server: `agentId` is the agent that is enabled there first. */
  const connect = (agentId: string) =>
    Promise.resolve(app.request('/v1/apps/discord/install', { method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ mode: 'oauth', agentId }) }));
  /** Enables an agent in the installed server. */
  const enable = (agentId: string) =>
    Promise.resolve(app.request('/v1/apps/discord/installations/discord:G1/agents/' + agentId, { method: 'PUT', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ enabled: true }) }));
  const ctx = () => ({ store, enqueuer, channels: testChannels, channelFetch: fakeDiscord });
  const guildMessage = (extra: Record<string, unknown>) => ({
    id: 'm' + String(Math.random()), channel_id: 'C1', guild_id: 'G1', author: { id: 'UOWNER', username: 'owner' }, content: '', mentions: [], mention_roles: [], ...extra,
  });

  async function install(): Promise<void> {
    const res = await connect('nova');
    expect(res.status).toBe(202);
    const body = installAppResponseSchema.parse(await res.json());
    const redirect = await app.request('/v1/channels/discord/oauth/callback?code=c&guild_id=G1&state=' + (body.pending?.id ?? ''), { headers: ownerHeaders(OWNER) });
    expect(redirect.status).toBe(200);
  }

  beforeEach(async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 8).toString('base64'));
    vi.stubEnv('CHANNELS_PUBLIC_URL', 'https://hooks.example.com');
    vi.stubEnv('DISCORD_APP_ID', 'APP1');
    vi.stubEnv('DISCORD_BOT_TOKEN', 'shared-bot-token');
    vi.stubEnv('CHANNELS_AVATAR_BASE_URL', 'https://cdn.example.com/avatars');
    wakes = [];
    calls = [];
    roles = 0;
    webhooksMade = 0;
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    app = createTestApp({ store, bus: mem.eventBus, enqueuer, channelFetch: fakeDiscord });
    await store.put('agents', makeAgent('juno', 'Juno', '2026-10-01T00:00:00.000Z'));
    await store.put('agents', makeAgent('nova', 'Nova', '2026-10-02T00:00:00.000Z'));
    return () => { vi.unstubAllEnvs(); };
  });

  it('gives the invite link with role, webhook and audit permissions', async () => {
    const body = installAppResponseSchema.parse(await (await connect('nova')).json());
    const url = new URL(body.openUrl ?? '');
    expect(url.searchParams.get('client_id')).toBe('APP1');
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    const bits = BigInt(url.searchParams.get('permissions') ?? '0');
    for (const bit of [28n, 29n, 7n, 10n, 11n, 16n, 6n, 20n, 21n]) expect((bits >> bit) & 1n).toBe(1n);
    expect(url.searchParams.get('redirect_uri')).toBe('https://hooks.example.com/v1/channels/discord/oauth/callback');
  });

  it('makes the installation, a mentionable role and the owner binding when the bot is added', async () => {
    await install();
    expect(await store.get('channelInstallations', 'discord:G1')).toMatchObject({ ownerId: OWNER, kind: 'discord', teamId: 'G1', botUserId: 'BOT', installedBy: 'UOWNER' });
    const role = calls.find((call) => call.path === '/guilds/G1/roles' && call.method === 'POST');
    expect(role?.body).toEqual({ name: 'Nova', mentionable: true });
    expect(role?.auth).toBe('Bot shared-bot-token');
    expect(await store.get('channels', 'discord:G1.nova')).toMatchObject({ installationId: 'discord:G1', roleId: 'R1', handle: 'Nova', handleStatus: 'ok', ownerExternalId: 'UOWNER' });
    // A second agent joins the same server without another invite.
    const again = await enable('juno');
    expect(again.status).toBe(200);
    expect(await store.get('channels', 'discord:G1.juno')).toMatchObject({ roleId: 'R2' });
  });

  it('routes a role mention to its agent, a bot mention and the owner\'s DM to the main agent, and ignores strangers', async () => {
    await install();
    await enable('juno');
    await admitSharedDiscordMessage(ctx(), 'BOT', guildMessage({ content: '<@&R1> summarise this', mention_roles: ['R1'] }));
    expect(wakes[0]).toMatchObject({ agentId: 'nova', kind: 'room_mention', payload: { text: 'summarise this', channelKind: 'discord', chatId: 'C1' } });
    await admitSharedDiscordMessage(ctx(), 'BOT', guildMessage({ content: '<@BOT> hi there', mentions: [{ id: 'BOT' }] }));
    expect(wakes[1]).toMatchObject({ agentId: 'juno', payload: { text: 'hi there' } });
    await admitSharedDiscordMessage(ctx(), 'BOT', { id: 'dm1', channel_id: 'DM1', author: { id: 'UOWNER' }, content: 'private', mentions: [], mention_roles: [] });
    expect(wakes[2]).toMatchObject({ agentId: 'juno', kind: 'user_message', trusted: true });
    const main = await store.get('conversations', wakes[2]?.conversationId ?? '');
    expect(main?.channel).toMatchObject({ kind: 'discord', chatId: 'DM1' });
    expect(main?.title).toMatch(/^Discord · /);
    await admitSharedDiscordMessage(ctx(), 'BOT', { id: 'dm2', channel_id: 'DM2', author: { id: 'USTRANGER' }, content: 'let me in', mentions: [], mention_roles: [] });
    await admitSharedDiscordMessage(ctx(), 'BOT', guildMessage({ content: 'no mention at all' }));
    expect(wakes).toHaveLength(3);
  });

  it('gives a group mention the recent channel messages as untrusted context, and stores none of them', async () => {
    await install();
    const history = [
      { id: 'h2', content: 'second', author: { id: 'U2', username: 'bob' } },
      { id: 'h1', content: 'first', author: { id: 'U3', username: 'cy', global_name: 'Cy' } },
    ];
    const fetchWithHistory: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/api/v10/channels/C1/messages' && (init?.method ?? 'GET') === 'GET') {
        calls.push({ method: 'GET', path: url.pathname + url.search, auth: new Headers(init?.headers).get('authorization'), body: {} });
        return Response.json(history);
      }
      return fakeDiscord(input, init);
    };
    await admitSharedDiscordMessage({ store, enqueuer, channels: testChannels, channelFetch: fetchWithHistory }, 'BOT', guildMessage({ id: 'trig', content: '<@&R1> thoughts?', mention_roles: ['R1'] }));
    expect(wakes[0]?.payload['channelContext']).toBe('Cy: first\nbob: second');
    expect(calls.some((call) => call.path === '/api/v10/channels/C1/messages?limit=30&before=trig' && call.auth === 'Bot shared-bot-token')).toBe(true);
    const items = (await store.list('items', { where: { conversationId: wakes[0]?.conversationId ?? '' }, limit: 20 })).items;
    expect(items).toHaveLength(1);
  });

  it('gives a later mention only the messages after the one it already saw, without its own replies, and names role mentions', async () => {
    await install();
    await enable('juno');
    // The channel's webhook (the agents' voice) exists once an agent has posted there.
    await store.patch('channelInstallations', 'discord:G1', { webhooks: { C1: { id: 'W1', token: 'wtok' } } });
    type Logged ={ id: string; content: string; author: Record<string, unknown>; webhook_id?: string; mentions?: unknown[]; mention_roles?: string[] };
    const channelLog: Logged[] = [
      { id: '101', content: 'first chatter', author: { id: 'U2', username: 'bob' } },
      { id: '102', content: 'second chatter', author: { id: 'U3', username: 'cy', global_name: 'Cy' } },
    ];
    const fetchWithLog: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/api/v10/channels/C1/messages' && (init?.method ?? 'GET') === 'GET') {
        const before = Number(url.searchParams.get('before') ?? '999999');
        return Response.json(channelLog.filter((entry) => Number(entry.id) < before).reverse());
      }
      return fakeDiscord(input, init);
    };
    const mention = (id: string, content: string) => {
      channelLog.push({ id, content, author: { id: 'UOWNER', username: 'owner' }, mention_roles: ['R1'] });
      return admitSharedDiscordMessage({ store, enqueuer, channels: testChannels, channelFetch: fetchWithLog }, 'BOT', guildMessage({ id, content, mention_roles: ['R1'] }));
    };

    await mention('103', '<@&R1> thoughts?');
    expect(wakes[0]?.payload['channelContext']).toBe('bob: first chatter\nCy: second chatter');

    // Nova answers through the webhook, people talk, Juno (another agent) greets Nova by role, then Nova is mentioned again.
    channelLog.push({ id: '104', content: 'my earlier answer', author: { id: 'W1', username: 'Nova', bot: true }, webhook_id: 'W1' });
    channelLog.push({ id: '105', content: 'later chatter', author: { id: 'U2', username: 'bob' } });
    channelLog.push({ id: '106', content: '<@&R1> over to you', author: { id: 'W1', username: 'Juno', bot: true }, webhook_id: 'W1', mention_roles: ['R1'] });
    channelLog.push({ id: '107', content: 'ping <@&R9> too', author: { id: 'U3', username: 'cy', global_name: 'Cy' }, mention_roles: ['R9'] });
    await mention('108', '<@&R1> and now?');
    const context = String(wakes[1]?.payload['channelContext']);
    expect(context).toBe('bob: later chatter\nJuno: @Nova over to you\nCy: ping @role too');
    expect(context).not.toMatch(/you \(Nova\)|first chatter|thoughts|earlier answer|<@&/);

    // Nothing new since the last wake: no context block at all.
    await mention('109', '<@&R1> hello?');
    expect(wakes[2]?.payload['channelContext']).toBeUndefined();
  });

  it('says so when a full window or the character cap left older messages out', async () => {
    await install();
    const window = Array.from({ length: 30 }, (_, i) => ({ id: String(300 - i), content: 'line ' + String(i), author: { id: 'U2', username: 'bob' } }));
    const fetchFull: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/api/v10/channels/C1/messages' && (init?.method ?? 'GET') === 'GET') return Response.json(window);
      return fakeDiscord(input, init);
    };
    await admitSharedDiscordMessage({ store, enqueuer, channels: testChannels, channelFetch: fetchFull }, 'BOT', guildMessage({ id: '400', content: '<@&R1> hi', mention_roles: ['R1'] }));
    expect(String(wakes[0]?.payload['channelContext'])).toMatch(/^\(earlier messages not shown\)\nbob: line 29\n/);

    const long = Array.from({ length: 10 }, (_, i) => ({ id: String(500 - i), content: 'x'.repeat(900) + String(i), author: { id: 'U2', username: 'bob' } }));
    const fetchLong: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/api/v10/channels/C1/messages' && (init?.method ?? 'GET') === 'GET') return Response.json(long);
      return fakeDiscord(input, init);
    };
    await admitSharedDiscordMessage({ store, enqueuer, channels: testChannels, channelFetch: fetchLong }, 'BOT', guildMessage({ id: '600', channel_id: 'C1', content: '<@&R1> again', mention_roles: ['R1'] }));
    const capped = String(wakes[1]?.payload['channelContext']);
    expect(capped.startsWith('(earlier messages not shown)\n')).toBe(true);
    expect(capped.length).toBeLessThan(6100);
  });

  describe('agents mentioning each other', () => {
    /** Nova answers in C1 (through the webhook) with `text`, in a run that was woken at `hop`; Discord's id for it is 'hook-msg'. */
    async function novaPosts(text: string, runId: string, hop?: { chainId: string; depth: number }): Promise<void> {
      if (wakes.length === 0) await admitSharedDiscordMessage(ctx(), 'BOT', guildMessage({ content: '<@&R1> go', mention_roles: ['R1'] }));
      const wake = wakes[0] as WakeEvent;
      const conversationId = wake.conversationId ?? '';
      const itemId = 'itm-' + runId;
      await store.put('items', { id: itemId, conversationId, type: 'agent_message', at: AT, agentId: 'nova', runId, markdown: text, citations: [], ...(replyOriginOf([wake]) ? { replyTo: replyOriginOf([wake]) } : {}) });
      if (hop) await recordRunHop(store, { agentId: 'nova', wakeEvents: [{ hop }] } as never, runId);
      expect((await deliverChannelReply(store, testChannels.senders(fakeDiscord), { ownerId: OWNER, conversationId, itemId })).status).toBe('sent');
    }
    const post = (extra: Record<string, unknown> = {}) => guildMessage({ id: 'hook-msg', webhook_id: 'W1', author: { id: 'W1', username: 'Nova', bot: true }, content: '<@&R2> come look at this', mention_roles: ['R2'], ...extra });

    it('wakes the mentioned agent one hop deeper, as an untrusted agent-origin message', async () => {
      await install();
      await enable('juno');
      await novaPosts('<@&R2> come look at this', 'run-1');
      wakes.length = 0;
      await admitSharedDiscordMessage(ctx(), 'BOT', post());
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({
        agentId: 'juno', kind: 'room_mention', origin: { type: 'agent', id: 'nova' }, trusted: false, priority: 'peer',
        hop: { chainId: 'run-1', depth: 1 }, payload: { text: 'come look at this', speakerRole: 'agent', speakerName: 'Nova', channelKind: 'discord', chatId: 'C1' },
      });
      const items = (await store.list('items', { where: { conversationId: wakes[0]?.conversationId ?? '' }, limit: 5 })).items;
      expect(items).toHaveLength(1);
      // The wake names the sending agent and its role; the stored message is marked as an agent's (`agent:<id>`), which the memory jobs read as agent text.
      expect(wakes[0]?.payload).toMatchObject({ fromAgentName: 'Nova', fromAgentRole: 'Test agent' });
      expect(items[0]).toMatchObject({ type: 'user_message', channelSender: { externalId: 'agent:nova', name: 'Nova' } });
    });

    it('turns "@Name" of another agent into its role mention on the way out, and a role mention into "@Name" on the way in', async () => {
      await install();
      await enable('juno');
      const rows = (await store.list('channels', { where: { kind: 'discord' }, limit: 10 })).items;
      const handleOf = (role: string): string => rows.find((row) => row.roleId === role)?.handle ?? '';
      const handle = handleOf('R2');
      calls.length = 0;
      await novaPosts('hey @' + handle + ' come look', 'run-5');
      expect(JSON.stringify(calls.filter((call) => call.method === 'POST').map((call) => call.body))).toContain('<@&R2> come look');
      wakes.length = 0;
      // A person names two agents: both are woken, first named first, and each sees both names to tell who was asked.
      await admitSharedDiscordMessage(ctx(), 'BOT', guildMessage({ content: '<@&R2> ask <@&R1> about it', mention_roles: ['R1', 'R2'] }));
      expect(wakes.map((wake) => wake.agentId)).toEqual(['juno', 'nova']);
      expect(wakes[0]?.payload['text']).toBe('@' + handle + ' ask @' + handleOf('R1') + ' about it');
    });

    it('continues the chain of the run that wrote the message', async () => {
      await install();
      await enable('juno');
      await novaPosts('<@&R2> again', 'run-2', { chainId: 'chain-9', depth: 2 });
      wakes.length = 0;
      await admitSharedDiscordMessage(ctx(), 'BOT', post());
      expect(wakes[0]?.hop).toEqual({ chainId: 'chain-9', depth: 3 });
    });

    it('wakes nobody for a self mention, an unrecorded message, or another bot or webhook', async () => {
      await install();
      await enable('juno');
      await novaPosts('<@&R1> myself', 'run-3');
      wakes.length = 0;
      await admitSharedDiscordMessage(ctx(), 'BOT', post({ mention_roles: ['R1'], content: '<@&R1> myself' }));
      await admitSharedDiscordMessage(ctx(), 'BOT', post({ id: 'never-recorded' }));
      await admitSharedDiscordMessage(ctx(), 'BOT', post({ webhook_id: 'WOTHER', author: { id: 'WOTHER', username: 'Nova', bot: true } }));
      await admitSharedDiscordMessage(ctx(), 'BOT', post({ author: { id: 'OTHERBOT', username: 'Other', bot: true }, webhook_id: undefined }));
      expect(wakes).toHaveLength(0);
    });

    it('wakes past the hop limit, where Session drops it', async () => {
      await install();
      await enable('juno');
      await novaPosts('<@&R2> deep', 'run-4', { chainId: 'chain-d', depth: LIMITS.chain.maxHopDepth });
      wakes.length = 0;
      await admitSharedDiscordMessage(ctx(), 'BOT', post());
      expect(wakes[0]?.hop?.depth).toBe(LIMITS.chain.maxHopDepth + 1);
      expect(checkHop(wakes[0] as WakeEvent).kind).toBe('drop');
    });
  });

  it('speaks in a server channel through a webhook with the agent\'s name and picture, and in a DM as the bot', async () => {
    await install();
    await admitSharedDiscordMessage(ctx(), 'BOT', guildMessage({ content: '<@&R1> go', mention_roles: ['R1'] }));
    const wake = wakes[0] as WakeEvent;
    const conversationId = wake.conversationId ?? '';
    const replyTo = replyOriginOf([wake]);
    expect(replyTo?.messageId).toBe(String(wake.payload['externalMessageId']));
    // A reply that quotes (the trigger is not known to be the latest) still goes out as the agent: a webhook cannot carry message_reference, so its first line is a subtext reply line.
    const { messageId: _answered, ...unthreaded } = replyTo ?? { kind: 'discord', channelId: '', chatId: '' };
    const senders = testChannels.senders(fakeDiscord);
    const threaded = async (id: string) => {
      await store.put('items', { id, conversationId, type: 'agent_message', at: AT, agentId: 'nova', markdown: 'threaded', citations: [], ...(replyTo ? { replyTo } : {}) });
      return deliverChannelReply(store, senders, { ownerId: OWNER, conversationId, itemId: id });
    };
    calls.length = 0;
    expect((await threaded('itm-t')).status).toBe('sent');
    const hooked = calls.find((call) => call.path.startsWith('/webhooks/'));
    expect(calls.some((call) => call.path === '/channels/C1/messages' && call.method === 'POST')).toBe(false);
    expect(hooked?.body).toMatchObject({ username: 'Nova' });
    expect(String(hooked?.body['content'])).toBe('-# ↪ replying to <@' + String(replyTo?.userId) + '> · https://discord.com/channels/G1/C1/' + String(replyTo?.messageId) + '\nthreaded');
    const reply = async (id: string) => {
      await store.put('items', { id, conversationId, type: 'agent_message', at: AT, agentId: 'nova', markdown: 'answer ' + id, citations: [], replyTo: unthreaded });
      return deliverChannelReply(store, senders, { ownerId: OWNER, conversationId, itemId: id });
    };
    calls.length = 0;
    expect((await reply('itm-1')).status).toBe('sent');
    expect(webhooksMade).toBe(1);
    const hook = calls.find((call) => call.path === '/webhooks/W1/wtok');
    expect(hook?.auth).toBeNull();
    expect(hook?.body).toMatchObject({ content: 'answer itm-1', username: 'Nova', avatar_url: expect.stringMatching(/^https:\/\/cdn\.example\.com\/avatars\/[a-z]+\.png$/) });
    // The webhook token is sealed on the installation and reused.
    const installation = await store.get('channelInstallations', 'discord:G1');
    expect(decryptSecret(installation?.webhooks?.['C1']?.token ?? '')).toBe('wtok');
    expect((await reply('itm-2')).status).toBe('sent');
    expect(webhooksMade).toBe(1);

    // A DM goes out as the bot itself.
    await admitSharedDiscordMessage(ctx(), 'BOT', { id: 'dm1', channel_id: 'DM1', author: { id: 'UOWNER' }, content: 'private', mentions: [], mention_roles: [] });
    const dm = wakes[1] as WakeEvent;
    // Admission put the 👀 working reaction on the DM (it comes off when the run finishes).
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'PUT' && call.path === '/channels/DM1/messages/dm1/reactions/%F0%9F%91%80/@me')).toBe(true));
    const dmOrigin = replyOriginOf([dm]);
    await store.put('items', { id: 'itm-dm', conversationId: dm.conversationId ?? '', type: 'agent_message', at: AT, agentId: 'juno', markdown: 'psst', citations: [], ...(dmOrigin ? { replyTo: dmOrigin } : {}) });
    calls.length = 0;
    expect((await deliverChannelReply(store, senders, { ownerId: OWNER, conversationId: dm.conversationId ?? '', itemId: 'itm-dm' })).status).toBe('sent');
    // (The admitted DM also got its 👀 working reaction; that call may land after the clear above.)
    expect(calls.map((call) => call.path).filter((path) => !path.includes('/reactions/'))).toEqual(['/channels/DM1/messages']);
    expect(calls[0]?.auth).toBe('Bot shared-bot-token');
  });
});
