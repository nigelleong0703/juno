// The app catalog as data (BACKEND 10.18): apps are packages (interface, mcpServers, skills, userConfig, tools, binding, status, version),
// seeded once from the built-ins and the chat platforms, then the table is what the page lists and what agents can use. Edits take effect in
// the running catalog without a restart as a new version, and a seed never overwrites an edited app.
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { AppCatalogRow, Store } from '../../../contracts/index.js';
import type { CatalogEntry } from '../../mcp/catalog.js';
import { composioAuthConfigEnv, withoutCoveredComposio } from '../../mcp/composio.js';
import { appAuthOf, appCatalogCreateSchema, appCatalogPatchSchema, CATALOG_OWNER, createStoredCatalog, entryRow, installBlockOf, rowEntry, rowProblem, userConfigList } from '../catalog.js';

const T0 = new Date('2026-10-26T00:00:00.000Z');
const acme: CatalogEntry = { id: 'acme', name: 'Acme', icon: 'acme', description: 'Acme records. They hold your customers.', category: 'productivity', url: 'https://mcp.acme.test/mcp', tryAsking: ['List my customers'] };
const gmail: CatalogEntry = { id: 'gmail', name: 'Gmail', icon: 'gmail', description: 'Read and send mail.', category: 'productivity', url: '/mcp/google/gmail', configuredClientIssuer: 'https://accounts.google.com', scopes: ['https://mail.google.com/'], toolAccess: { send_email: 'change' } };
const keyed: CatalogEntry = {
  id: 'hevy', name: 'Hevy', icon: 'fitness', description: 'Workouts.', category: 'health', url: '/mcp/hevy', auth: 'api_key',
  userConfig: { api_key: { type: 'string', title: 'Hevy API key', description: 'From settings.', required: true, sensitive: true } },
  headers: { 'api-key': '${user_config.api_key}' },
  probe: { tool: 'workout_count' },
};
const chatSeed: AppCatalogRow = {
  id: 'slack@1', ownerId: CATALOG_OWNER, appId: 'slack', version: 1, category: 'chat',
  interface: { displayName: 'Slack', shortDescription: 'Agents in Slack.', longDescription: 'Your agents answer in Slack.', icon: 'slack', defaultPrompts: [] },
  mcpServers: {}, skills: [], userConfig: {}, binding: { plugin: 'slack' }, status: 'listed', createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
};

const fresh = (): Store => createMemoryStore();
// The page's order is the order of creation, so each seed is a millisecond after the last (agentd/src/apps/seed.ts does the same).
const at = (ms: number): string => new Date(T0.getTime() + ms).toISOString();
const seeds = () => [chatSeed, entryRow(acme, at(1)), entryRow(gmail, at(2))];
const interfaceOf = (name: string) => ({ displayName: name, shortDescription: 'Short.', longDescription: 'Long.', icon: 'x', defaultPrompts: ['Ask'] });
const work = { id: 'ok-app', category: 'work', interface: interfaceOf('Ok'), mcpServers: { ok: { type: 'streamable-http', url: 'https://mcp.ok.test/mcp', auth: 'oauth' } } };

describe('seeding', () => {
  it('writes version 1 of every seed under the system owner and serves the newest versions in seed order', async () => {
    const store = fresh();
    const catalog = await createStoredCatalog({ store, seed: seeds() });
    expect(catalog.rows().map((row) => row.appId)).toEqual(['slack', 'acme', 'gmail']);
    expect(catalog.list().map((entry) => entry.id)).toEqual(['acme', 'gmail']);
    expect(catalog.get('acme')).toMatchObject({ name: 'Acme', url: 'https://mcp.acme.test/mcp', version: 1 });
    expect(catalog.rows().find((row) => row.appId === 'acme')?.interface).toMatchObject({ shortDescription: 'Acme records.', defaultPrompts: ['List my customers'] });
    expect((await store.get('appCatalog', 'acme@1'))?.ownerId).toBe(CATALOG_OWNER);
    expect(catalog.get('slack')).toBeUndefined();
  });

  it('an app the table already has is never overwritten by a later seed; a new built-in is added', async () => {
    const store = fresh();
    const first = await createStoredCatalog({ store, seed: seeds() });
    await first.update('acme', { interface: interfaceOf('Acme CRM'), status: 'hidden' });
    await first.retire('gmail');
    const second = await createStoredCatalog({ store, seed: [...seeds(), entryRow({ ...acme, id: 'zeta', name: 'Zeta' }, at(3))] });
    expect(second.rows().find((row) => row.appId === 'acme')).toMatchObject({ interface: { displayName: 'Acme CRM' }, status: 'hidden', version: 2 });
    expect(second.rows().find((row) => row.appId === 'gmail')?.status).toBe('retired');
    expect(second.list().map((entry) => entry.id)).toEqual(['zeta']);
  });

  it('a built-in becomes a package and back to the same entry (the tools and the MCP manager read the entry)', () => {
    const row = entryRow(gmail, T0.toISOString());
    expect(row).toMatchObject({ category: 'work', version: 1, status: 'listed', mcpServers: { gmail: { type: 'streamable-http', auth: 'oauth', url: '/mcp/google/gmail', oauth: { client: 'provided', issuer: 'https://accounts.google.com', scopes: ['https://mail.google.com/'] } } }, tools: { send_email: 'change' } });
    expect(rowEntry(row)).toEqual({ ...gmail, auth: 'oauth', oauthClient: 'provided', version: 1 });
    expect(appAuthOf(row)).toBe('oauth');
  });

  it('a Composio app is a package with a toolkit and no server; a toolkit without the source, or a server beside it, is refused; a first-party twin hides it', () => {
    const composio: CatalogEntry = { id: 'spotify', name: 'Spotify', icon: 'video', description: 'Playlists.', category: 'media', url: '', source: 'composio', toolkit: 'spotify' };
    const row = entryRow(composio, T0.toISOString());
    expect(row).toMatchObject({ category: 'work', source: 'composio', toolkit: 'spotify', mcpServers: {}, userConfig: {} });
    expect(rowProblem(row)).toBeUndefined();
    expect(rowEntry(row)).toMatchObject({ id: 'spotify', source: 'composio', toolkit: 'spotify', url: '', auth: 'oauth' });
    expect(appAuthOf(row)).toBe('oauth');
    expect(rowProblem({ ...row, source: undefined })).toContain('go together');
    expect(rowProblem({ ...row, mcpServers: { s: { type: 'streamable-http', url: 'https://x.test/mcp', auth: 'none' } } })).toContain('no MCP servers');
    expect(rowProblem({ ...row, category: 'chat', binding: { plugin: 'slack' } })).toContain('only a work app');

    // Offered only with the key (and our own app's auth config for a toolkit Composio has no managed app for), and never beside a first-party app of the same name.
    const keyed = { COMPOSIO_API_KEY: 'k' };
    const entries = [composio, { ...acme, id: 'notion' }, { ...composio, id: 'notion-composio', toolkit: 'notion' }, { ...composio, id: 'trello', toolkit: 'trello' }];
    expect(withoutCoveredComposio(entries, {}).map((entry) => entry.id)).toEqual(['notion']);
    expect(withoutCoveredComposio(entries, keyed).map((entry) => entry.id)).toEqual(['notion', 'trello']);
    expect(withoutCoveredComposio(entries, { ...keyed, [composioAuthConfigEnv('spotify')]: 'ac_1' }).map((entry) => entry.id)).toEqual(['spotify', 'notion', 'trello']);
  });

  it('a key-in-a-header connector keeps its key as a user value in a header, never in the package', () => {
    const row = entryRow(keyed, T0.toISOString());
    expect(row.userConfig).toEqual(keyed.userConfig);
    expect(row.mcpServers['hevy']).toMatchObject({ auth: 'api_key', headers: { 'api-key': '${user_config.api_key}' } });
    expect(userConfigList(row.userConfig)).toEqual([{ key: 'api_key', type: 'string', title: 'Hevy API key', description: 'From settings.', required: true, sensitive: true }]);
    expect(rowEntry(row)).toMatchObject({ auth: 'api_key', userConfig: keyed.userConfig, headers: keyed.headers, probe: { tool: 'workout_count' } });
    expect(rowProblem(row)).toBeUndefined();
  });

  it('a key is believed only after a probe: an api_key package without one is refused, and a sign-in app may not carry one', () => {
    const row = entryRow(keyed, T0.toISOString());
    const server = row.mcpServers['hevy'];
    if (server === undefined) throw new Error('no server');
    const { probe: _dropped, ...unprobed } = server;
    expect(rowProblem({ ...row, mcpServers: { hevy: unprobed } })).toContain('needs a probe');
    expect(rowProblem({ ...row, mcpServers: { hevy: { ...server, auth: 'oauth' } } })).toContain('a sign-in proves itself');
  });
});

describe('versions and admin writes', () => {
  it('create adds an app that is offered at once, without a restart', async () => {
    const catalog = await createStoredCatalog({ store: fresh(), seed: seeds(), now: () => T0 });
    const made = await catalog.create(appCatalogCreateSchema.parse(work));
    expect(made).toMatchObject({ ok: true, row: { id: 'ok-app@1', appId: 'ok-app', version: 1, status: 'listed', skills: [], userConfig: {} } });
    expect(catalog.list().map((entry) => entry.id)).toContain('ok-app');
    expect(catalog.get('ok-app')?.url).toBe('https://mcp.ok.test/mcp');
  });

  it('every edit is a new version: the newest is served, the history is kept', async () => {
    const catalog = await createStoredCatalog({ store: fresh(), seed: seeds() });
    expect(await catalog.update('acme', { interface: interfaceOf('Acme 2') })).toMatchObject({ ok: true, row: { id: 'acme@2', version: 2 } });
    expect(await catalog.update('acme', { keywords: ['crm'] })).toMatchObject({ ok: true, row: { version: 3, keywords: ['crm'], interface: { displayName: 'Acme 2' } } });
    expect(catalog.get('acme')).toMatchObject({ name: 'Acme 2', version: 3 });
    expect(catalog.versions('acme').map((row) => [row.version, row.interface.displayName])).toEqual([[1, 'Acme'], [2, 'Acme 2'], [3, 'Acme 2']]);
    expect(catalog.rows().filter((row) => row.appId === 'acme')).toHaveLength(1);
    // The page's order is the order the apps were first created in, however often they are edited.
    expect(catalog.rows().map((row) => row.appId)).toEqual(['slack', 'acme', 'gmail']);
  });

  it('refuses an id that exists (retired ones too) and a package whose parts do not fit its category', async () => {
    const catalog = await createStoredCatalog({ store: fresh(), seed: seeds() });
    await catalog.retire('acme');
    expect(await catalog.create(appCatalogCreateSchema.parse({ ...work, id: 'acme' }))).toMatchObject({ ok: false, status: 409, code: 'APP_EXISTS' });
    expect(await catalog.create(appCatalogCreateSchema.parse({ ...work, id: 'nothing', mcpServers: {} }))).toMatchObject({ ok: false, status: 400, code: 'INVALID_APP' });
    const chat = appCatalogCreateSchema.parse({ id: 'wechat', category: 'chat', interface: interfaceOf('WeChat'), binding: { plugin: 'wechat' } });
    expect(await catalog.create(chat, ['slack'])).toMatchObject({ ok: false, status: 400, message: expect.stringContaining('no chat platform plugin "wechat"') });
    expect(catalog.rows().map((row) => row.appId)).toEqual(['slack', 'acme', 'gmail']);
  });

  it('update changes fields, null clears an optional one, and the running catalog shows it', async () => {
    const catalog = await createStoredCatalog({ store: fresh(), seed: seeds(), now: () => T0 });
    const changed = await catalog.update('gmail', { tools: null, readOnly: true });
    expect(changed).toMatchObject({ ok: true, row: { readOnly: true } });
    expect(catalog.get('gmail')).toMatchObject({ readOnly: true });
    expect(catalog.get('gmail')?.toolAccess).toBeUndefined();
    expect(await catalog.update('nope', { status: 'hidden' })).toMatchObject({ ok: false, status: 404 });
    // A server that needs a provided client keeps the scopes to ask for.
    const noScopes = { acme: { type: 'streamable-http' as const, url: 'https://mcp.acme.test/mcp', auth: 'oauth' as const, oauth: { client: 'provided' as const, issuer: 'https://accounts.google.com' } } };
    expect(await catalog.update('acme', { mcpServers: noScopes })).toMatchObject({ ok: false, status: 400 });
  });

  it('hidden keeps existing installs working (get) but is no longer offered (list); retired is gone from both and can come back', async () => {
    const catalog = await createStoredCatalog({ store: fresh(), seed: seeds() });
    await catalog.update('acme', { status: 'hidden' });
    expect(catalog.list().map((entry) => entry.id)).toEqual(['gmail']);
    expect(catalog.get('acme')?.id).toBe('acme');
    expect(catalog.hidden().map((entry) => entry.id)).toEqual(['acme']);
    await catalog.retire('acme');
    expect(catalog.get('acme')).toBeUndefined();
    expect(catalog.hidden()).toEqual([]);
    await catalog.update('acme', { status: 'listed' });
    expect(catalog.list().map((entry) => entry.id)).toContain('acme');
  });

  it('another process\'s write shows after a refresh, with no restart', async () => {
    const store = fresh();
    const mine = await createStoredCatalog({ store, seed: seeds() });
    const theirs = await createStoredCatalog({ store, seed: seeds() });
    await theirs.retire('gmail');
    expect(mine.get('gmail')).toBeDefined();
    await mine.refresh();
    expect(mine.get('gmail')).toBeUndefined();
  });
});

describe('the package', () => {
  const okSkill = { name: 'triage-inbox', description: 'Triage mail. Use when the person asks what needs a reply.', instructions: 'Search unread mail, group by sender, draft replies.' };

  it('carries skills, an onboarding skill and the flat entry shows them to the runtime', async () => {
    const catalog = await createStoredCatalog({ store: fresh(), seed: [] });
    const made = await catalog.create(appCatalogCreateSchema.parse({ ...work, skills: [okSkill, { ...okSkill, name: 'welcome' }], onboardingSkill: 'welcome' }));
    expect(made.ok).toBe(true);
    expect(catalog.get('ok-app')).toMatchObject({ skills: [okSkill, { ...okSkill, name: 'welcome' }], onboardingSkill: 'welcome' });
    expect(await catalog.update('ok-app', { onboardingSkill: 'missing' })).toMatchObject({ ok: false, message: expect.stringContaining('onboardingSkill') });
    expect(await catalog.update('ok-app', { skills: [okSkill, okSkill] })).toMatchObject({ ok: false, message: expect.stringContaining('unique') });
  });

  it('userConfig is declared once and referenced from the URL path or a header; a sensitive value only in a header, and every reference must be declared', async () => {
    const catalog = await createStoredCatalog({ store: fresh(), seed: [] });
    const server = (extra: object) => ({ ok: { type: 'streamable-http' as const, url: 'https://mcp.ok.test/mcp', auth: 'api_key' as const, probe: { tool: 'ping' }, ...extra } });
    const key = { type: 'string' as const, title: 'API key', description: 'Your key.', required: true, sensitive: true };
    const good = appCatalogCreateSchema.parse({ ...work, mcpServers: server({ headers: { authorization: 'Bearer ${user_config.token}' } }), userConfig: { token: key } });
    expect(await catalog.create(good)).toMatchObject({ ok: true });
    const tryIt = async (id: string, mcpServers: object, userConfig: object) => catalog.create(appCatalogCreateSchema.parse({ ...work, id, mcpServers, userConfig }));
    expect(await tryIt('sens-url', server({ url: 'https://mcp.ok.test/${user_config.token}/mcp', auth: 'oauth' }), { token: key })).toMatchObject({ ok: false, message: expect.stringContaining('sensitive value goes in a header') });
    expect(await tryIt('undeclared', server({ headers: { authorization: '${user_config.nope}' } }), { token: key })).toMatchObject({ ok: false, message: expect.stringContaining('not declared') });
    expect(await tryIt('keyless', server({}), {})).toMatchObject({ ok: false, message: expect.stringContaining('api_key') });
    expect(await tryIt('unused', server({ headers: { authorization: '${user_config.token}' } }), { token: key, extra: { type: 'string', title: 'E', description: '' } })).toMatchObject({ ok: false, message: expect.stringContaining('not used') });
    // A workspace name belongs in the path, never in the host (the owner's value must not choose where the gateway connects).
    const host = appCatalogCreateSchema.safeParse({ ...work, id: 'in-host', mcpServers: server({ url: 'https://${user_config.ws}.ok.test/mcp', auth: 'oauth' }), userConfig: { ws: { type: 'string', title: 'W', description: '' } } });
    expect(host.success).toBe(false);
    expect(await tryIt('in-path', server({ url: 'https://mcp.ok.test/${user_config.ws}/mcp', auth: 'oauth', probe: undefined }), { ws: { type: 'string', title: 'Workspace', description: 'Its name', required: true } })).toMatchObject({ ok: true });
  });

  it('defaults and options are checked against the field type', () => {
    const base = { ...work, userConfig: { region: { type: 'string', title: 'Region', description: '', options: ['eu', 'us'], default: 'asia' } }, mcpServers: { ok: { type: 'streamable-http', url: 'https://mcp.ok.test/${user_config.region}', auth: 'oauth' } } };
    const parsed = appCatalogCreateSchema.parse(base);
    expect(rowProblem({ ...parsed, ...{ readOnly: undefined, tools: undefined } } as never)).toContain('default is not one of the options');
  });

  it('auth none goes with a deployment key; mixed and more than one server are accepted by the schema and refused at install', () => {
    const keyedNone = appCatalogCreateSchema.parse({ ...work, mcpServers: { ok: { type: 'streamable-http', url: 'https://mcp.ok.test/mcp', auth: 'oauth', platformKey: true } } });
    expect(rowProblem(keyedNone as never)).toContain('auth none');
    const mixed = appCatalogCreateSchema.parse({ ...work, mcpServers: { ok: { type: 'streamable-http', url: 'https://mcp.ok.test/mcp', auth: 'mixed' } } });
    expect(rowProblem(mixed as never)).toBeUndefined();
    expect(installBlockOf(mixed)).toContain('public tools');
    expect(rowEntry({ ...entryRow(acme, T0.toISOString()), ...mixed, id: 'ok-app@1', ownerId: CATALOG_OWNER, appId: 'ok-app', version: 1, createdAt: '', updatedAt: '' } as AppCatalogRow)?.installBlock).toContain('public tools');
    const two = appCatalogCreateSchema.parse({ ...work, mcpServers: { one: work.mcpServers.ok, two: work.mcpServers.ok } });
    expect(rowProblem(two as never)).toBeUndefined();
    expect(installBlockOf(two)).toContain('more than one MCP server');
  });

  it('OAuth client credentials are secret NAMES, never values', () => {
    const named = (extra: object) => appCatalogCreateSchema.safeParse({ ...work, mcpServers: { ok: { type: 'streamable-http', url: 'https://mcp.ok.test/mcp', auth: 'oauth', oauth: { client: 'provided', issuer: 'https://auth.ok.test', scopes: ['read'], ...extra } } } });
    expect(named({ clientIdName: 'OK_CLIENT_ID', clientSecretName: 'OK_CLIENT_SECRET' }).success).toBe(true);
    expect(named({ clientIdName: 'abc123-the-actual-id', clientSecretName: 'OK_CLIENT_SECRET' }).success).toBe(false);
    expect(named({ clientSecret: 'shh' }).success).toBe(false);
  });
});

describe('validation', () => {
  const bad = (input: unknown): boolean => !appCatalogCreateSchema.safeParse(input).success;

  it('create refuses what is not a whole, plain app package', () => {
    expect(appCatalogCreateSchema.safeParse(work).success).toBe(true);
    expect(bad({ ...work, id: 'Bad Id' })).toBe(true);
    expect(bad({ ...work, id: 'x' })).toBe(true);
    expect(bad({ ...work, category: 'custom' })).toBe(true);
    expect(bad({ ...work, extra: 1 })).toBe(true);
    expect(bad({ ...work, mcpServers: { ok: { ...work.mcpServers.ok, url: 'http://mcp.ok.test/mcp' } } })).toBe(true);
    expect(bad({ ...work, mcpServers: { ok: { ...work.mcpServers.ok, type: 'sse' } } })).toBe(true);
    expect(bad({ ...work, mcpServers: { ok: { ...work.mcpServers.ok, surprise: true } } })).toBe(true);
    expect(bad({ ...work, interface: { ...interfaceOf('Ok'), defaultPrompts: Array.from({ length: 7 }, () => 'x') } })).toBe(true);
    expect(bad({ ...work, interface: { ...interfaceOf('Ok'), brandColor: 'red' } })).toBe(true);
    expect(bad({ ...work, interface: { ...interfaceOf('Ok'), displayName: '' } })).toBe(true);
    expect(bad({ ...work, status: 'retired' })).toBe(true);
    expect(bad({ ...work, skills: [{ name: 'Not Kebab', description: 'd', instructions: 'i' }] })).toBe(true);
    expect(bad({ ...work, skills: [{ name: 'ok', description: 'd'.repeat(1025), instructions: 'i' }] })).toBe(true);
  });

  it('patch takes any subset but never the id or category, and no unknown field', () => {
    expect(appCatalogPatchSchema.safeParse({ keywords: ['x'] }).success).toBe(true);
    expect(appCatalogPatchSchema.safeParse({ id: 'other' }).success).toBe(false);
    expect(appCatalogPatchSchema.safeParse({ category: 'chat' }).success).toBe(false);
    expect(appCatalogPatchSchema.safeParse({ status: 'retired' }).success).toBe(false);
    expect(appCatalogPatchSchema.safeParse({ name: 'Flat' }).success).toBe(false);
  });

  it('whole-package checks tie a category to its parts', () => {
    const row = (extra: object) => ({ category: 'work' as const, mcpServers: { ok: { type: 'streamable-http' as const, url: 'https://mcp.ok.test/mcp', auth: 'oauth' as const } }, userConfig: {}, skills: [], ...extra });
    expect(rowProblem(row({}))).toBeUndefined();
    expect(rowProblem(row({ mcpServers: { ok: { type: 'streamable-http', url: 'https://mcp.ok.test/mcp', auth: 'api_key' } } }))).toContain('api_key');
    expect(rowProblem({ category: 'chat', mcpServers: {}, userConfig: {}, skills: [] })).toContain('binding.plugin');
    expect(rowProblem({ category: 'web', mcpServers: {}, userConfig: {}, skills: [], binding: { plugin: 'slack' } })).toContain('no chat plugin');
    expect(rowProblem(row({ binding: { plugin: 'slack' } }))).toContain('no chat plugin');
    // A web app the agent reads through its computer has a channel and the skill that uses it, with or without a sign-in; a sign-in slot (no login) needs neither.
    const web = (extra: object) => ({ category: 'web' as const, mcpServers: {}, userConfig: {}, skills: [], ...extra });
    const skill = [{ name: 'agent-reach', description: 'd', instructions: 'i' }];
    expect(rowProblem(web({ binding: { reach: 'xiaohongshu' } }))).toBeUndefined();
    expect(rowProblem(web({ binding: { reach: 'youtube', login: 'none' } }))).toContain('binding.reach');
    expect(rowProblem(web({ binding: { login: 'none' }, skills: skill }))).toContain('binding.reach');
    expect(rowProblem(web({ binding: { reach: 'youtube', login: 'none' }, skills: skill }))).toBeUndefined();
    expect(rowProblem(web({ binding: { reach: 'xiaohongshu', login: 'sandbox' }, skills: skill }))).toBeUndefined();
    expect(rowProblem(web({ binding: { login: 'sandbox' }, skills: skill }))).toContain('binding.reach');
  });
});
