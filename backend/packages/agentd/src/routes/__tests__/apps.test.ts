/**
 * The Apps routes through agentd's HTTP surface (BACKEND 10.18): what the page lists (chat, work, custom), who may use each app and with
 * which Actions policy, the capability list with read and change marks, removing a bot or workspace, and that turning an app off for an
 * agent holds the routine that needs it. Slack and the MCP server are fakes; nothing touches the network.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store, WakeEvent } from '@agent-desktop/contracts';
import { appDetailSchema, appSchema, type App, type Routine } from '@agent-desktop/public-contracts';
import { createStoredCatalog, type StoredCatalog } from 'juno-agent/modules/apps/catalog';
import { BUILTIN_CATALOG_ENTRIES } from 'juno-agent/modules/mcp/catalog';
import type { McpManager } from 'juno-agent/modules/mcp/index';
import { platformSkillsDir } from '@agent-desktop/memory-graph/skills';
import { seedRows, webSeedRows } from '../../apps/seed.js';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const OWNER = 'owner-a';
const NOW = '2026-10-26T00:00:00.000Z';

let store: Store;
let app: Hono;
let appCatalog: StoredCatalog;
const as = (path: string, init: { method?: string; body?: unknown } = {}) => requestAs(app, OWNER, path, init);
const apps = async (): Promise<App[]> => ((await (await as('/v1/apps')).json()) as { items: unknown[] }).items.map((item) => appSchema.parse(item));
const appOf = async (id: string): Promise<App | undefined> => (await apps()).find((candidate) => candidate.id === id);
const connection = (id: string, catalogId: string | undefined, extra: object = {}) =>
  store.put('connections', { id, kind: 'mcp', name: catalogId ?? 'My server', status: 'connected', enabled: true, ownerId: OWNER, ...(catalogId === undefined ? { endpoint: 'https://mcp.example.com/mcp' } : { catalogId }), ...extra } as never);
const policy = (agentId: string, appId: string, extra: object) => store.put('agentApps', { id: agentId + ':' + appId, ownerId: OWNER, agentId, appId, enabled: true, actionsPolicy: 'ask', updatedAt: NOW, ...extra } as never);

/** An MCP manager that lists one read tool and one change tool for any connection. */
const fakeMcp = { listTools: async () => [{ name: 'list_things', title: 'List things', description: '', access: 'read' }, { name: 'make_thing', title: 'Make a thing', description: '', access: 'action', needsReview: true }] } as unknown as McpManager;

beforeEach(async () => {
  const mem = createMemoryStore();
  store = withDefaultOwner(mem, OWNER);
  const enqueuer = { async enqueue(event: WakeEvent) { void event; return { accepted: true }; }, async stopRun() {}, async resolveAwakeable() {}, async scheduleRoutine() {} } as never;
  appCatalog = await createStoredCatalog({ store: mem, seed: seedRows(BUILTIN_CATALOG_ENTRIES, ['slack', 'discord', 'telegram', 'feishu'], new Date(), await webSeedRows(platformSkillsDir())) });
  app = createTestApp({ store, bus: mem.eventBus, enqueuer, appCatalog, mcp: fakeMcp, config: { SEARCH_PROVIDER: 'exa' } as never });
  for (const [id, name] of [['agt-1', 'Mira'], ['agt-2', 'Nova']] as const) await store.put('agents', { id, name, handle: id, createdBy: OWNER, ownerId: OWNER, pluginIds: [], createdAt: NOW, updatedAt: NOW } as never);
  await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agt-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: NOW, createdAt: NOW } as never);
});

describe('GET /v1/apps', () => {
  it('lists the chat apps, the catalog and nothing added, with the grants each app offers', async () => {
    const listed = await apps();
    expect(listed.filter((entry) => entry.category === 'chat').map((entry) => entry.id)).toEqual(['slack', 'discord', 'telegram', 'feishu']);
    expect(await appOf('slack')).toMatchObject({ grants: { chatRead: true, actions: false }, installations: [], enabledAgents: [] });
    expect(await appOf('gmail')).toMatchObject({ category: 'work', group: 'productivity', grants: { chatRead: true, actions: true }, installations: [], enabledAgents: [] });
    // A read-only server offers no Actions grant; an app that takes the owner's own key says so.
    expect((await appOf('strava'))?.grants).toEqual({ chatRead: true, actions: false });
    expect(await appOf('hevy')).toMatchObject({ auth: 'api_key', userConfig: [{ key: 'api_key', title: 'Hevy API key', sensitive: true, required: true }] });
    // A provider that needs an OAuth client this server lacks cannot be added yet.
    expect((await appOf('strava'))?.available).toBe(false);
  });

  it('an added app lists its accounts and which agents may use it, with each policy; no row means everyone, asking first', async () => {
    await connection('con-1', 'gmail', { account: 'me@example.com', connectedAt: NOW });
    await connection('con-2', 'notion', { status: 'error', connectedAt: NOW });
    await connection('con-3', 'linear', { enabled: false, status: 'disconnected' });
    await policy('agt-2', 'gmail', { actionsPolicy: 'off' });
    await policy('agt-1', 'notion', { enabled: false });
    expect(await appOf('gmail')).toMatchObject({
      installations: [{ id: 'con-1', label: 'me@example.com', status: 'connected', connectedAt: NOW }],
      enabledAgents: [{ agentId: 'agt-1', actionsPolicy: 'ask' }, { agentId: 'agt-2', actionsPolicy: 'off' }],
    });
    expect(await appOf('notion')).toMatchObject({ installations: [{ status: 'expired' }], enabledAgents: [{ agentId: 'agt-2', actionsPolicy: 'ask' }] });
    // An account the owner removed is not an installation.
    expect((await appOf('linear'))?.installations).toEqual([]);
  });

  it('a custom server is an app of its own, named by its connection; a removed one is gone', async () => {
    await connection('con-x', undefined, { name: 'Weather', connectedAt: NOW });
    await connection('con-y', undefined, { name: 'Old', enabled: false, status: 'disconnected' });
    expect(await appOf('con-x')).toMatchObject({ name: 'Weather', category: 'custom', installations: [{ id: 'con-x', label: 'Weather', status: 'connected' }], enabledAgents: [{ agentId: 'agt-1' }, { agentId: 'agt-2' }] });
    expect(await appOf('con-y')).toBeUndefined();
  });

});

describe('GET /v1/apps/:id', () => {
  it('adds the capability list with read and change marks', async () => {
    await connection('con-1', 'notion', { connectedAt: NOW });
    const detail = appDetailSchema.parse(await (await as('/v1/apps/notion')).json());
    expect(detail.capabilities).toEqual([{ name: 'list_things', title: 'List things', kind: 'read' }, { name: 'make_thing', title: 'Make a thing', kind: 'change', needsReview: true }]);
    // Not signed in: nothing to list. A chat app lists what the chat can do: hearing and reading are read; sending files, reacting and buttons change.
    expect(appDetailSchema.parse(await (await as('/v1/apps/gmail')).json()).capabilities).toEqual([]);
    const slack = appDetailSchema.parse(await (await as('/v1/apps/slack')).json());
    expect(Object.fromEntries(slack.capabilities.map((capability) => [capability.name, capability.kind]))).toEqual({
      reply: 'read', history: 'read', files_receive: 'read', files_send: 'change', react: 'change', buttons: 'change',
    });
    // Telegram cannot read history, so that line is not listed.
    const telegram = appDetailSchema.parse(await (await as('/v1/apps/telegram')).json());
    expect(telegram.capabilities.map((capability) => capability.name)).not.toContain('history');
    expect((await as('/v1/apps/nope')).status).toBe(404);
  });
});

describe('POST /v1/apps/:id/tools/review', () => {
  const review = (appId: string, body: unknown) => as('/v1/apps/' + appId + '/tools/review', { method: 'POST', body });

  it('marks the flagged tools of every account of the app reviewed, once; other tools, chat apps and unknown apps are refused or untouched', async () => {
    await connection('con-1', 'notion', { toolReview: { make_thing: { hash: 'a', reviewed: false }, other: { hash: 'b', reviewed: false }, list_things: { hash: 'c', reviewed: true } } });
    await connection('con-2', 'notion', { toolReview: { make_thing: { hash: 'a', reviewed: false } } });
    expect(await (await review('notion', { tools: ['make_thing', 'list_things'] })).json()).toEqual({ reviewed: ['make_thing'] });
    expect(Reflect.get((await store.get('connections', 'con-1')) ?? {}, 'toolReview')).toEqual({ make_thing: { hash: 'a', reviewed: true }, other: { hash: 'b', reviewed: false }, list_things: { hash: 'c', reviewed: true } });
    expect(Reflect.get((await store.get('connections', 'con-2')) ?? {}, 'toolReview')).toEqual({ make_thing: { hash: 'a', reviewed: true } });
    // Without names: every flagged tool. Asking again finds nothing left.
    expect(await (await review('notion', {})).json()).toEqual({ reviewed: ['other'] });
    expect(await (await review('notion', {})).json()).toEqual({ reviewed: [] });
    expect((await review('slack', {})).status).toBe(400);
    expect((await review('nope', {})).status).toBe(404);
    expect((await review('notion', { tools: 'make_thing' })).status).toBe(400);
  });
});

describe('PUT /v1/agents/:agentId/apps/:appId', () => {
  const put = (agentId: string, appId: string, body: unknown) => as('/v1/agents/' + agentId + '/apps/' + appId, { method: 'PUT', body });

  it('turns an added app on or off for one agent and sets its Actions policy; a field left out keeps its value', async () => {
    await connection('con-1', 'gmail');
    const off = await put('agt-1', 'gmail', { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ agentId: 'agt-1', appId: 'gmail', enabled: false, actionsPolicy: 'ask' });
    expect((await put('agt-1', 'gmail', { enabled: true, actionsPolicy: 'allow' })).status).toBe(200);
    expect((await put('agt-1', 'gmail', { enabled: true })).status).toBe(200);
    expect((await appOf('gmail'))?.enabledAgents).toEqual([{ agentId: 'agt-1', actionsPolicy: 'allow' }, { agentId: 'agt-2', actionsPolicy: 'ask' }]);
  });

  it('refuses what is not valid: a body that is not the shape, an unknown agent or app, a chat app, an app that is not added', async () => {
    await connection('con-1', 'gmail');
    expect((await put('agt-1', 'gmail', { enabled: 'yes' })).status).toBe(400);
    expect((await put('agt-1', 'gmail', { enabled: true, actionsPolicy: 'sometimes' })).status).toBe(400);
    expect((await put('ghost', 'gmail', { enabled: true })).status).toBe(404);
    expect((await put('agt-1', 'nope', { enabled: true })).status).toBe(404);
    const chat = await put('agt-1', 'slack', { enabled: true });
    expect(chat.status).toBe(400);
    expect(((await chat.json()) as { error: { code: string } }).error.code).toBe('CHAT_APP');
    const missing = await put('agt-1', 'notion', { enabled: true });
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('APP_NOT_ADDED');
  });

  it('holds the routine that needs the app when it is turned off for its agent, and starts it again when it is turned on', async () => {
    await connection('con-1', 'google-calendar');
    const routine = (await (await as('/v1/routines', { method: 'POST', body: { name: 'Brief', agentId: 'agt-1', instructions: 'Brief me', trigger: { kind: 'schedule', cron: '0 8 * * *', human: 'Daily 8:00', tz: 'UTC' }, delivery: { channel: 'chat', target: 'conv-1' }, requires: [{ capability: 'calendar', options: ['google-calendar'] }] } })).json()) as Routine;
    expect(routine.status).toBe('active');
    await put('agt-1', 'google-calendar', { enabled: false });
    expect(((await (await as('/v1/routines/' + routine.id)).json()) as Routine).status).toBe('needs_setup');
    const card = (await store.list('requests')).items.find((request) => request.kind === 'connect' && request.status === 'pending');
    expect(card?.payload).toMatchObject({ appIds: ['google-calendar'], problems: { 'google-calendar': 'not_enabled' }, routineId: routine.id });
    await put('agt-1', 'google-calendar', { enabled: true });
    expect(((await (await as('/v1/routines/' + routine.id)).json()) as Routine).status).toBe('active');
    expect((await store.get('requests', card?.id ?? ''))?.status).toBe('approved');
  });
});

describe('removing a bot and installing', () => {
  it('a work app is added through the gateway: this service refuses it, naming why', async () => {
    const res = await as('/v1/apps/gmail/install', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_A_CHAT_APP');
    expect((await as('/v1/apps/gmail/installations/con-1', { method: 'DELETE' })).status).toBe(400);
  });

  it('a web app that needs no sign-in is listed as addable, adding it turns it on for every agent, adding twice is one installation, and it is per agent from then on', async () => {
    const put = (agentId: string, appId: string, body: unknown) => as('/v1/agents/' + agentId + '/apps/' + appId, { method: 'PUT', body });
    expect((await apps()).filter((entry) => entry.category === 'web').map((entry) => entry.id)).toEqual(['youtube-videos', 'bilibili', 'xiaohongshu', 'v2ex', 'github-reading']);
    expect(await appOf('youtube-videos')).toMatchObject({ category: 'web', auth: 'none', available: true, grants: { chatRead: true, actions: false }, installations: [], enabledAgents: [], tryAsking: expect.any(Array) });
    expect((await put('agt-1', 'youtube-videos', { enabled: true })).status).toBe(409);
    const added = await as('/v1/apps/youtube-videos/install', { method: 'POST', body: {} });
    expect(added.status).toBe(201);
    const first = (await added.json()) as { appId: string; installation: { id: string; status: string } };
    expect(first).toMatchObject({ appId: 'youtube-videos', installation: { status: 'connected' }, pending: null, openUrl: null });
    expect(((await (await as('/v1/apps/youtube-videos/install', { method: 'POST', body: {} })).json()) as typeof first).installation.id).toBe(first.installation.id);
    expect(await appOf('youtube-videos')).toMatchObject({ installations: [{ id: first.installation.id, label: 'YouTube videos' }], enabledAgents: [{ agentId: 'agt-1' }, { agentId: 'agt-2' }] });
    await put('agt-2', 'youtube-videos', { enabled: false });
    expect((await appOf('youtube-videos'))?.enabledAgents).toEqual([{ agentId: 'agt-1', actionsPolicy: 'ask' }]);
    const detail = (await (await as('/v1/apps/youtube-videos')).json()) as { skills: unknown[]; capabilities: unknown[] };
    expect(detail).toMatchObject({ capabilities: [], skills: [{ name: 'agent-reach', onboarding: true }] });
  });

  it('a web app that reads through the computer with a sign-in is addable: adding it turns it on, and the sign-in is asked for when a read needs it', async () => {
    const put = (agentId: string, appId: string, body: unknown) => as('/v1/agents/' + agentId + '/apps/' + appId, { method: 'PUT', body });
    expect(await appOf('xiaohongshu')).toMatchObject({ category: 'web', auth: 'sandbox_login', available: true, installations: [], enabledAgents: [] });
    expect((await put('agt-1', 'xiaohongshu', { enabled: true })).status).toBe(409);
    const added = await as('/v1/apps/xiaohongshu/install', { method: 'POST', body: {} });
    expect(added.status).toBe(201);
    expect(await appOf('xiaohongshu')).toMatchObject({ installations: [{ label: 'Xiaohongshu' }], enabledAgents: [{ agentId: 'agt-1' }, { agentId: 'agt-2' }] });
    const detail = (await (await as('/v1/apps/xiaohongshu')).json()) as { skills: unknown[]; capabilities: unknown[] };
    expect(detail).toMatchObject({ capabilities: [], skills: [{ name: 'agent-reach', onboarding: true }] });
  });

  it('a web app row without a sign-in setting is a slot: listed, not addable', async () => {
    expect((await appCatalog.create({ id: 'signin-slot', category: 'web', interface: { displayName: 'Slot', shortDescription: 'Slot.', longDescription: 'Slot.', icon: 'note', defaultPrompts: [] }, mcpServers: {}, skills: [], userConfig: {}, binding: { reach: 'xiaohongshu' }, status: 'listed' })).ok).toBe(true);
    expect(await appOf('signin-slot')).toMatchObject({ auth: 'sandbox_login', available: false });
    const res = await as('/v1/apps/signin-slot/install', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('APP_NOT_SUPPORTED_YET');
  });

  it('an agent\'s own bot belongs to it: no other agent is enabled on it, and removing it deletes the row; a pending install can be cancelled', async () => {
    await store.put('channels', { id: 'telegram:Bot', ownerId: OWNER, agentId: 'agt-1', kind: 'telegram', channelId: 'Bot', secretHashHex: 'x', status: 'active', createdAt: NOW, updatedAt: NOW } as never);
    expect((await appOf('telegram'))?.installations).toMatchObject([{ id: 'telegram:Bot', label: '@Bot', agentId: 'agt-1', agents: [{ agentId: 'agt-1', handle: null }] }]);
    const other = await as('/v1/apps/telegram/installations/telegram:Bot/agents/agt-2', { method: 'PUT', body: { enabled: true } });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe('OWN_BOT');
    await store.put('channels', { id: 'pending:abc', ownerId: OWNER, agentId: 'agt-1', kind: 'pending', channelId: 'abc', secretHashHex: 'x', status: 'pending', pending: { platform: 'telegram', state: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString(), createUrl: 'https://t.me/newbot/x' }, createdAt: NOW, updatedAt: NOW } as never);
    expect(appDetailSchema.parse(await (await as('/v1/apps/telegram')).json()).pending).toMatchObject([{ id: 'abc', status: 'pending', openUrl: 'https://t.me/newbot/x' }]);
    expect((await as('/v1/apps/telegram/installations/abc', { method: 'DELETE' })).status).toBe(204);
    expect((await as('/v1/apps/telegram/installations/telegram:Bot', { method: 'DELETE' })).status).toBe(204);
    expect(await store.get('channels', 'telegram:Bot')).toBeNull();
    expect((await as('/v1/apps/telegram/installations/telegram:Bot', { method: 'DELETE' })).status).toBe(404);
  });
});
