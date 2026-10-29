/**
 * The app catalog admin routes (BACKEND 10.18) through agentd's HTTP surface: an operator adds, edits, hides and retires apps with no code
 * change and no restart, and the owner API follows at once. The seed is the built-in connectors plus the four chat platforms.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store, WakeEvent } from '@agent-desktop/contracts';
import { appSchema, type App } from '@agent-desktop/public-contracts';
import { createStoredCatalog, type StoredCatalog } from 'juno-agent/modules/apps/catalog';
import { BUILTIN_CATALOG_ENTRIES } from 'juno-agent/modules/mcp/catalog';
import { createTestApp, requestAs, TEST_INTERNAL_TOKEN, withDefaultOwner } from '../../__tests__/test-app.js';
import { seedRows } from '../seed.js';

const OWNER = 'owner-a';
const NOW = '2026-10-26T00:00:00.000Z';
const KINDS = ['slack', 'discord', 'telegram', 'feishu'];

let store: Store;
let app: Hono;
let catalog: StoredCatalog;

/** An operator request: the service bearer alone, no owner header. */
const admin = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => app.request(path, {
  method: init.method ?? 'GET',
  headers: { authorization: 'Bearer ' + (init.token ?? TEST_INTERNAL_TOKEN), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
});
const json = async (response: Response): Promise<Record<string, unknown>> => (await response.json()) as Record<string, unknown>;
const apps = async (): Promise<App[]> => ((await (await requestAs(app, OWNER, '/v1/apps')).json()) as { items: unknown[] }).items.map((item) => appSchema.parse(item));
const appOf = async (id: string): Promise<App | undefined> => (await apps()).find((candidate) => candidate.id === id);
const face = (name: string, extra: object = {}) => ({ displayName: name, shortDescription: 'Customers and deals.', longDescription: 'Look up customers and deals in ' + name + '.', icon: 'crm', defaultPrompts: ['Who are my biggest customers?'], ...extra });
const acme = {
  id: 'acme-crm', category: 'work', interface: face('Acme CRM', { developerName: 'Acme Inc.' }),
  mcpServers: { acme: { type: 'streamable-http', url: 'https://mcp.acme.test/mcp', auth: 'oauth' } },
  skills: [{ name: 'pipeline-review', description: 'Review the sales pipeline. Use when asked how deals are going.', instructions: 'List open deals by stage, then flag the stale ones.' }],
};

beforeEach(async () => {
  const mem = createMemoryStore();
  store = withDefaultOwner(mem, OWNER);
  const enqueuer = { async enqueue(event: WakeEvent) { void event; return { accepted: true }; }, async stopRun() {}, async resolveAwakeable() {}, async scheduleRoutine() {} } as never;
  catalog = await createStoredCatalog({ store: mem, seed: seedRows(BUILTIN_CATALOG_ENTRIES, KINDS) });
  app = createTestApp({ store, bus: mem.eventBus, enqueuer, appCatalog: catalog });
});

describe('access', () => {
  it('needs the service bearer and no owner; anyone else is refused', async () => {
    expect((await app.request('/v1/admin/apps')).status).toBe(401);
    expect((await admin('/v1/admin/apps', { token: 'wrong' })).status).toBe(401);
    expect((await admin('/v1/admin/apps', { method: 'POST', body: acme, token: 'wrong' })).status).toBe(401);
    expect((await admin('/v1/admin/apps')).status).toBe(200);
    // The owner API's own routes still need an owner.
    expect((await app.request('/v1/apps', { headers: { authorization: 'Bearer ' + TEST_INTERNAL_TOKEN } })).status).toBe(401);
  });
});

describe('seed', () => {
  it('the table starts as the four chat platforms and every built-in connector, in the page\'s order, listed', async () => {
    const rows = (await json(await admin('/v1/admin/apps'))).items as Array<Record<string, unknown>>;
    expect(rows.map((row) => row['id'])).toEqual([...KINDS, ...BUILTIN_CATALOG_ENTRIES.map((entry) => entry.id)]);
    expect(rows.every((row) => row['status'] === 'listed' && row['ownerId'] === undefined)).toBe(true);
    expect(rows.find((row) => row['id'] === 'slack')).toMatchObject({ category: 'chat', version: 1, binding: { plugin: 'slack' }, interface: { displayName: 'Slack' } });
    expect(rows.find((row) => row['id'] === 'gmail')).toMatchObject({ category: 'work', version: 1, mcpServers: { gmail: { type: 'streamable-http', auth: 'oauth', url: expect.stringContaining('gmail') } } });
    expect(rows.find((row) => row['id'] === 'hevy')).toMatchObject({ userConfig: { api_key: { sensitive: true, required: true } }, mcpServers: { hevy: { auth: 'api_key', headers: { 'api-key': '${user_config.api_key}' } } } });
    expect((await apps()).map((entry) => entry.id).slice(0, 4)).toEqual(KINDS);
  });
});

describe('create', () => {
  it('adds an app the owner sees at once, with its blurb, examples and sign-in kind, and no restart', async () => {
    expect(await appOf('acme-crm')).toBeUndefined();
    const response = await admin('/v1/admin/apps', { method: 'POST', body: acme });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ id: 'acme-crm', version: 1, status: 'listed', createdAt: expect.any(String) });
    expect(await appOf('acme-crm')).toMatchObject({ category: 'work', name: 'Acme CRM', blurb: 'Customers and deals.', tryAsking: ['Who are my biggest customers?'], auth: 'oauth', version: 1, developerName: 'Acme Inc.', userConfig: [], installations: [] });
    // The detail lists the skills the package ships.
    const detail = await json(await requestAs(app, OWNER, '/v1/apps/acme-crm'));
    expect(detail['skills']).toEqual([{ name: 'pipeline-review', description: expect.stringContaining('pipeline'), onboarding: false }]);
  });

  it('a web app is a listed slot that cannot be added yet; its Agent Reach channel name is stored', async () => {
    const response = await admin('/v1/admin/apps', { method: 'POST', body: { id: 'xiaohongshu', category: 'web', interface: face('Xiaohongshu'), binding: { reach: 'xiaohongshu' } } });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ binding: { reach: 'xiaohongshu' } });
    expect(await appOf('xiaohongshu')).toMatchObject({ category: 'web', auth: 'sandbox_login', available: false, installations: [] });
  });

  it('an app that asks for values lists them for the install form; a package this install flow cannot add yet is listed as unavailable', async () => {
    const keyed = { ...acme, id: 'keyed-app', mcpServers: { keyed: { type: 'streamable-http', url: 'https://mcp.keyed.test/mcp', auth: 'api_key', headers: { 'x-key': '${user_config.token}' }, probe: { tool: 'whoami' } } }, userConfig: { token: { type: 'string', title: 'Token', description: 'Your token.', required: true, sensitive: true } } };
    expect((await admin('/v1/admin/apps', { method: 'POST', body: keyed })).status).toBe(201);
    expect(await appOf('keyed-app')).toMatchObject({ auth: 'api_key', userConfig: [{ key: 'token', title: 'Token', required: true, sensitive: true, type: 'string' }], available: true });
    const mixed = { ...acme, id: 'mixed-app', mcpServers: { mixed: { type: 'streamable-http', url: 'https://mcp.mixed.test/mcp', auth: 'mixed' } } };
    expect((await admin('/v1/admin/apps', { method: 'POST', body: mixed })).status).toBe(201);
    expect(await appOf('mixed-app')).toMatchObject({ auth: 'mixed', available: false });
  });

  it('refuses what is wrong with 4xx and leaves the table alone', async () => {
    const before = catalog.rows().length;
    const refused = async (body: unknown) => (await admin('/v1/admin/apps', { method: 'POST', body })).status;
    expect(await refused({ ...acme, surprise: true })).toBe(400);
    expect(await refused({ ...acme, id: 'Not A Slug' })).toBe(400);
    expect(await refused({ ...acme, mcpServers: { acme: { ...acme.mcpServers.acme, url: 'http://mcp.acme.test/mcp' } } })).toBe(400);
    expect(await refused({ ...acme, category: 'custom' })).toBe(400);
    expect(await refused({ ...acme, mcpServers: {} })).toBe(400);
    expect(await refused({ id: 'wechat', category: 'chat', interface: face('WeChat'), binding: { plugin: 'wechat' } })).toBe(400);
    expect(await refused({ ...acme, onboardingSkill: 'nothing' })).toBe(400);
    expect(await refused({ ...acme, id: 'gmail' })).toBe(409);
    expect((await admin('/v1/admin/apps', { method: 'POST' })).status).toBe(400);
    const bad = await json(await admin('/v1/admin/apps', { method: 'POST', body: { ...acme, interface: { ...acme.interface, defaultPrompts: 'no' } } }));
    expect(bad).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('defaultPrompts') } });
    expect(catalog.rows()).toHaveLength(before);
  });
});

describe('update', () => {
  it('changes the listing text and the owner API shows it at once; null clears an optional field', async () => {
    const gmailFace = ((await json(await admin('/v1/admin/apps'))).items as Array<{ id: string; interface: object }>).find((row) => row.id === 'gmail')?.interface ?? {};
    const response = await admin('/v1/admin/apps/gmail', { method: 'PATCH', body: { interface: { ...gmailFace, shortDescription: 'Your mail, read and drafted.', defaultPrompts: ['Summarise my unread mail'] }, readOnly: true } });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ id: 'gmail', version: 2, readOnly: true });
    expect(await appOf('gmail')).toMatchObject({ blurb: 'Your mail, read and drafted.', tryAsking: ['Summarise my unread mail'], version: 2, grants: { chatRead: true, actions: false } });
    const cleared = await json(await admin('/v1/admin/apps/gmail', { method: 'PATCH', body: { readOnly: null } }));
    expect(cleared['readOnly']).toBeUndefined();
    expect((await appOf('gmail'))?.grants.actions).toBe(true);
    // Every edit is a version; the history is kept.
    const history = (await json(await admin('/v1/admin/apps/gmail/versions'))).items as Array<{ version: number }>;
    expect(history.map((row) => row.version)).toEqual([1, 2, 3]);
    expect((await admin('/v1/admin/apps/nothing/versions')).status).toBe(404);
  });

  it('refuses an empty change, a field that is not editable and an unknown app', async () => {
    expect((await admin('/v1/admin/apps/gmail', { method: 'PATCH', body: {} })).status).toBe(400);
    expect((await admin('/v1/admin/apps/gmail', { method: 'PATCH', body: { id: 'x' } })).status).toBe(400);
    expect((await admin('/v1/admin/apps/gmail', { method: 'PATCH', body: { category: 'chat' } })).status).toBe(400);
    expect((await admin('/v1/admin/apps/gmail', { method: 'PATCH', body: { status: 'retired' } })).status).toBe(400);
    expect((await admin('/v1/admin/apps/gmail', { method: 'PATCH', body: { name: 'Flat' } })).status).toBe(400);
    expect((await admin('/v1/admin/apps/nothing', { method: 'PATCH', body: { keywords: ['x'] } })).status).toBe(404);
    expect((await admin('/v1/admin/apps/nothing/retire', { method: 'POST' })).status).toBe(404);
  });
});

describe('hide and retire', () => {
  const connection = (id: string, catalogId: string) => store.put('connections', { id, kind: 'mcp', name: catalogId, status: 'connected', enabled: true, ownerId: OWNER, catalogId, connectedAt: NOW } as never);
  beforeEach(async () => {
    await store.put('agents', { id: 'agt-1', name: 'Mira', handle: 'agt-1', createdBy: OWNER, ownerId: OWNER, pluginIds: [], createdAt: NOW, updatedAt: NOW } as never);
  });

  it('hidden: no longer offered, but the owner who added it still sees and keeps it', async () => {
    await connection('con-1', 'notion');
    await admin('/v1/admin/apps/notion', { method: 'PATCH', body: { status: 'hidden' } });
    await admin('/v1/admin/apps/linear', { method: 'PATCH', body: { status: 'hidden' } });
    expect(await appOf('notion')).toMatchObject({ installations: [{ id: 'con-1' }], enabledAgents: [{ agentId: 'agt-1' }] });
    expect(await appOf('linear')).toBeUndefined();
    expect((await json(await admin('/v1/admin/apps'))).items).toContainEqual(expect.objectContaining({ id: 'linear', status: 'hidden' }));
  });

  it('retired: gone from the owner\'s page, installed or not, and nothing more can be done with it', async () => {
    await connection('con-1', 'notion');
    const response = await admin('/v1/admin/apps/notion/retire', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ id: 'notion', status: 'retired' });
    await admin('/v1/admin/apps/slack/retire', { method: 'POST' });
    expect(await appOf('notion')).toBeUndefined();
    expect(await appOf('slack')).toBeUndefined();
    expect((await requestAs(app, OWNER, '/v1/apps/notion')).status).toBe(404);
    expect((await requestAs(app, OWNER, '/v1/agents/agt-1/apps/notion', { method: 'PUT', body: { enabled: false } })).status).toBe(404);
    expect((await requestAs(app, OWNER, '/v1/apps/slack/install', { method: 'POST', body: { mode: 'oauth' } })).status).toBe(404);
    // The row stays for the admin, and a later edit brings the app back.
    expect(catalog.rows().find((row) => row.appId === 'notion')?.status).toBe('retired');
    await admin('/v1/admin/apps/notion', { method: 'PATCH', body: { status: 'listed' } });
    expect(await appOf('notion')).toMatchObject({ installations: [{ id: 'con-1' }] });
  });

  it('a hidden chat app refuses new installs', async () => {
    await admin('/v1/admin/apps/telegram', { method: 'PATCH', body: { status: 'hidden' } });
    expect((await requestAs(app, OWNER, '/v1/apps/telegram/install', { method: 'POST', body: { agentId: 'agt-1', token: 'x' } })).status).toBe(404);
  });
});
