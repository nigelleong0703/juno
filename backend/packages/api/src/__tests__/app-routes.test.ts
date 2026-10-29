/**
 * App-owned routes: the API owns durable settings, integrations, library and activity for the
 * request owner. These pin the behaviour the private service used to provide - persistence,
 * partial merge, owner isolation, spoof refusal - plus the routing rule that only the declared
 * agentd method+path pairs are ever forwarded upstream. Responses are parsed with zod because the
 * runtime Response body is unknown.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { AuditEntry, Conversation, LibraryItem, Plugin, Run } from '@agent-desktop/public-contracts';
import type { ModelCatalog } from '@agent-desktop/public-contracts';
import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';
import { createAgentdModelCatalogLoader, type ModelCatalogLoader } from '../modules/settings.js';

const UPSTREAM = 'http://127.0.0.1:8788';
const SERVICE_TOKEN = 'service-token';
const A = 'owner-a';
const B = 'owner-b';

const settingsView = z.object({
  general: z.object({ launchAtLogin: z.boolean(), language: z.string(), aboutMe: z.string().optional() }),
  appearance: z.object({ theme: z.string() }),
  privacy: z.object({ dataRetentionDays: z.number() }),
});
const libraryView = z.object({ items: z.array(z.object({ id: z.string(), pinned: z.boolean() })) });
const pluginView = z.object({ tools: z.array(z.object({ id: z.string(), permission: z.string() })) });
const connectionView = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  endpoint: z.string().optional(),
  enabled: z.boolean().optional(),
});
const installView = z.object({
  appId: z.string(),
  openUrl: z.string().nullable(),
  installation: z.object({ id: z.string(), appId: z.string(), label: z.string(), status: z.string() }).nullable(),
});
const auditView = z.object({ items: z.array(z.object({ id: z.string() })) });
const usageView = z.object({
  week: z.object({ inputTokens: z.number() }),
  byAgent: z.array(
    z.object({
      agentId: z.string(),
      runs: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      computeSeconds: z.number(),
      costUsd: z.number(),
    }),
  ),
  byApp: z.array(z.unknown()),
});
const ledgerView = z.object({
  items: z.array(
    z.object({
      runId: z.string(),
      agentId: z.string(),
      parentRunId: z.string().optional(),
      model: z.string().optional(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number(),
      startedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  byModel: z.array(z.object({ model: z.string(), runs: z.number(), inputTokens: z.number(), costUsd: z.number() })),
});

function parseBody<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return res.json().then((value) => schema.parse(value));
}

function testAuth(): ApiAuth {
  const owners: Record<string, string> = { 'sess-a': A, 'sess-b': B };
  return {
    info: { mode: 'account', providers: ['credential'] },
    handle: async () => new Response('auth', { status: 200 }),
    resolve: async (request) => {
      const header = request.headers.get('authorization');
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
      const ownerId = token ? owners[token] : undefined;
      return ownerId ? { ownerId } : null;
    },
  };
}

interface Harness {
  app: ReturnType<typeof createApiApp>;
  upstream: string[];
}

function catalogLoader(ids: string[]): ModelCatalogLoader {
  return async (): Promise<ModelCatalog> => ({
    defaultModel: ids[0] ?? 'model-a',
    items: ids.map((id) => ({ id, name: id, supportsImages: false })),
  });
}

function build(store: Store, options: { modelsLoader?: ModelCatalogLoader } = {}): Harness {
  const upstream: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // The gateway's own lookups of the effective tiers and System One model for a settings read are not forwarded routes.
    if (!/\/v1\/model-providers\/(tiers|system-one)$/.test(url)) upstream.push(url);
    return Response.json({ items: [] });
  };
  const app = createApiApp({
    auth: testAuth(),
    agentdUrl: UPSTREAM,
    internalToken: SERVICE_TOKEN,
    fetch: fetchFn,
    store, blobs: createMemoryBlobStore(),
    ...(options.modelsLoader ? { modelsLoader: options.modelsLoader } : {}),
  });
  return { app, upstream };
}

interface CallOptions {
  method?: string;
  body?: unknown;
  spoof?: string;
}

function call(h: Harness, path: string, session: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: 'Bearer ' + session };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.spoof !== undefined) headers['x-owner-id'] = options.spoof;
  return Promise.resolve(
    h.app.request(path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
}

function ownerStore(store: Store, owner: string): Store {
  const scoped = store.forOwner?.(owner);
  if (!scoped) throw new Error('test store is missing forOwner');
  return scoped;
}

function libraryItem(id: string, owner: string): LibraryItem & { ownerId: string } {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    kind: 'document',
    mimeType: 'text/plain',
    sizeBytes: 1,
    shared: 'private',
    source: 'upload',
    tags: [],
    createdAt: now,
    updatedAt: now,
    pinned: false,
    ownerId: owner,
  };
}

function plugin(id: string): Plugin {
  return {
    id,
    name: 'Slack',
    publisher: 'Slack',
    category: 'Productivity',
    description: 'Team chat',
    icon: 'slack',
    installed: false,
    featured: false,
    tools: [{ id: 'tool-1', pluginId: id, name: 'Post', description: 'Post a message', permission: 'ask' }],
    accounts: [],
    usedByAgentIds: [],
  };
}

function auditEntry(id: string, extra: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id,
    at: new Date().toISOString(),
    actor: 'agent',
    action: 'Send email',
    decision: 'asked',
    reason: 'Approval rule',
    initiator: { type: 'owner_message', conversationId: 'cvn-1' },
    unattended: false,
    ...extra,
  };
}

function runDoc(id: string, agentId: string, startedAt: string, tokens: number, extra: Partial<Run> = {}): Run {
  return {
    ...extra,
    id,
    agentId,
    title: 'Run',
    status: 'completed',
    kind: 'chat',
    steps: [],
    usage: { inputTokens: tokens, outputTokens: tokens, computeSeconds: 1, costUsd: 0.5, steps: 0 },
    startedAt,
    lastActivityAt: startedAt,
  };
}

describe('app-owned settings', () => {
  it('persists a merged partial update and isolates owners across independent factories', async () => {
    const store = createMemoryStore();
    const first = build(store);
    const patch = await call(first, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { general: { launchAtLogin: true, language: 'zh-CN' } },
    });
    expect(patch.status).toBe(200);
    expect((await parseBody(patch, settingsView)).general.language).toBe('zh-CN');

    const privacy = await call(first, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { privacy: { dataRetentionDays: 30, trainingOptIn: false } },
    });
    expect(privacy.status).toBe(200);

    // A second factory over the same store proves the write is durable, not app state.
    const second = build(store);
    const settings = await parseBody(await call(second, '/v1/settings', 'sess-a'), settingsView);
    expect(settings.general.language).toBe('zh-CN');
    expect(settings.general.launchAtLogin).toBe(true);
    expect(settings.privacy.dataRetentionDays).toBe(30);
    expect(settings.appearance.theme).toBe('system');

    const other = await parseBody(await call(second, '/v1/settings', 'sess-b'), settingsView);
    expect(other.general.language).toBe('en');
    expect(other.privacy.dataRetentionDays).toBe(90);

    expect(first.upstream).toHaveLength(0);
    expect(second.upstream).toHaveLength(0);
  });

  it('stores a reported IANA timezone without touching other general fields, and rejects anything else', async () => {
    const store = createMemoryStore();
    const h = build(store);
    await call(h, '/v1/settings', 'sess-a', { method: 'PATCH', body: { general: { language: 'zh-CN' } } });
    const ok = await call(h, '/v1/settings', 'sess-a', { method: 'PATCH', body: { general: { timezone: 'Asia/Singapore', timezoneAuto: true } } });
    expect(ok.status).toBe(200);
    const view = z.object({ general: z.object({ language: z.string(), timezone: z.string() }) });
    expect((await parseBody(ok, view)).general).toMatchObject({ language: 'zh-CN', timezone: 'Asia/Singapore' });
    const locale = await call(h, '/v1/settings', 'sess-a', { method: 'PATCH', body: { general: { locale: 'zh-Hans-SG' } } });
    expect(locale.status).toBe(200);
    expect((await call(h, '/v1/settings', 'sess-a', { method: 'PATCH', body: { general: { locale: 'not a locale!' } } })).status).toBe(400);
    for (const timezone of ['+08:00', 'Mars/Olympus', "UTC'; rm -rf /"]) {
      const bad = await call(h, '/v1/settings', 'sess-a', { method: 'PATCH', body: { general: { timezone } } });
      expect(bad.status, timezone).toBe(400);
    }
  });

  it('replaces the usage budget so clearing a field removes the constraint', async () => {
    const store = createMemoryStore();
    const h = build(store);
    const usageView = z.object({
      usage: z.object({ steps: z.number().optional(), onUnknown: z.string().optional() }).optional(),
    });

    const set = await call(h, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { usage: { steps: 5, onUnknown: 'block' } },
    });
    expect(set.status).toBe(200);
    expect((await parseBody(set, usageView)).usage?.steps).toBe(5);

    // Blanking steps must clear it, not silently retain the previous 5.
    const cleared = await call(h, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { usage: { onUnknown: 'ignore' } },
    });
    expect(cleared.status).toBe(200);
    const reread = await parseBody(await call(h, '/v1/settings', 'sess-a'), usageView);
    expect(reread.usage?.steps).toBeUndefined();
    expect(reread.usage?.onUnknown).toBe('ignore');
  });

  it('refuses a spoofed owner header on a settings write', async () => {
    const store = createMemoryStore();
    const h = build(store);
    const written = await call(h, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { general: { launchAtLogin: false, language: 'zh-CN' } },
      spoof: B,
    });
    expect(written.status).toBe(200);
    expect((await parseBody(await call(h, '/v1/settings', 'sess-a'), settingsView)).general.language).toBe('zh-CN');
    expect((await parseBody(await call(h, '/v1/settings', 'sess-b'), settingsView)).general.language).toBe('en');
  });
});

describe('app-owned library', () => {
  it('scopes list, direct read and writes to the request owner', async () => {
    const store = createMemoryStore();
    await ownerStore(store, A).put('library', libraryItem('lib-a', A));
    await ownerStore(store, B).put('library', libraryItem('lib-b', B));
    const h = build(store);

    const listA = await parseBody(await call(h, '/v1/library', 'sess-a'), libraryView);
    expect(listA.items.map((item) => item.id)).toEqual(['lib-a']);
    const listB = await parseBody(await call(h, '/v1/library', 'sess-b'), libraryView);
    expect(listB.items.map((item) => item.id)).toEqual(['lib-b']);

    expect((await call(h, '/v1/library/lib-b', 'sess-a')).status).toBe(404);
    expect((await call(h, '/v1/library/lib-ghost', 'sess-a')).status).toBe(404);
    expect((await call(h, '/v1/library/lib-a', 'sess-a')).status).toBe(200);

    const foreignPin = await call(h, '/v1/library/lib-a/pinned', 'sess-b', {
      method: 'POST',
      body: { pinned: true },
    });
    expect(foreignPin.status).toBe(404);
    const ownPin = await call(h, '/v1/library/lib-a/pinned', 'sess-a', {
      method: 'POST',
      body: { pinned: true },
    });
    expect(ownPin.status).toBe(200);
    expect((await parseBody(ownPin, z.object({ pinned: z.boolean() }))).pinned).toBe(true);
    expect((await ownerStore(store, B).get('library', 'lib-b'))?.pinned).toBe(false);

    expect((await h.app.request('/v1/library')).status).toBe(401);
    expect(h.upstream).toHaveLength(0);
  });

  it('scopes the library list to one owner conversation before pagination', async () => {
    const store = createMemoryStore();
    const at = new Date().toISOString();
    const conversation = (id: string, kind: Conversation['kind']): Conversation => ({
      id,
      kind,
      agentIds: ['agent-juno'],
      memberIds: [],
      unreadCount: 0,
      lastItemAt: at,
      createdAt: at,
    });
    await ownerStore(store, A).put('conversations', conversation('conv-1', 'direct'));
    await ownerStore(store, A).put('conversations', conversation('conv-2', 'room'));

    const scopedItem = (id: string, conversationId: string): LibraryItem & { ownerId: string } => ({
      ...libraryItem(id, A),
      conversationId,
      createdByAgentId: 'agent-juno',
    });
    await ownerStore(store, A).put('library', scopedItem('lib-a1', 'conv-1'), { conversationId: 'conv-1' });
    await ownerStore(store, A).put('library', scopedItem('lib-a2', 'conv-1'), { conversationId: 'conv-1' });
    await ownerStore(store, A).put('library', scopedItem('lib-a3', 'conv-1'), { conversationId: 'conv-1' });
    await ownerStore(store, A).put('library', scopedItem('lib-b1', 'conv-2'), { conversationId: 'conv-2' });
    await ownerStore(store, A).put('library', libraryItem('lib-legacy', A));
    const h = build(store);

    const pageView = z.object({ items: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() });
    const scoped = async (path: string, session: string) => parseBody(await call(h, path, session), pageView);

    const first = await scoped('/v1/library?conversationId=conv-1&limit=2', 'sess-a');
    expect(first.items.map((item) => item.id)).toEqual(['lib-a1', 'lib-a2']);
    if (first.nextCursor === null) throw new Error('expected a second page for the scoped library query');
    const second = await scoped(
      '/v1/library?conversationId=conv-1&limit=2&cursor=' + encodeURIComponent(first.nextCursor),
      'sess-a',
    );
    expect(second.items.map((item) => item.id)).toEqual(['lib-a3']);
    expect(second.nextCursor).toBeNull();

    expect((await scoped('/v1/library?conversationId=conv-2', 'sess-a')).items.map((item) => item.id)).toEqual([
      'lib-b1',
    ]);

    const global = await scoped('/v1/library', 'sess-a');
    expect(global.items.map((item) => item.id).sort()).toEqual(['lib-a1', 'lib-a2', 'lib-a3', 'lib-b1', 'lib-legacy']);

    expect((await scoped('/v1/library?conversationId=conv-1', 'sess-b')).items).toEqual([]);
    expect((await scoped('/v1/library?conversationId=conv-ghost', 'sess-a')).items).toEqual([]);
    expect(h.upstream).toHaveLength(0);
  });
});

describe('app-owned integrations', () => {
  it('updates a real tool permission and records MCP servers as disconnected', async () => {
    const store = createMemoryStore();
    await ownerStore(store, A).put('plugins', plugin('plg-1'));
    const h = build(store);

    const permission = await call(h, '/v1/plugins/tool-permission', 'sess-a', {
      method: 'POST',
      body: { pluginId: 'plg-1', toolId: 'tool-1', permission: 'always' },
    });
    expect(permission.status).toBe(200);
    expect((await parseBody(permission, pluginView)).tools[0]?.permission).toBe('always');

    const missingTool = await call(h, '/v1/plugins/tool-permission', 'sess-a', {
      method: 'POST',
      body: { pluginId: 'plg-1', toolId: 'ghost', permission: 'always' },
    });
    expect(missingTool.status).toBe(404);

    const invalid = await call(h, '/v1/plugins/tool-permission', 'sess-a', {
      method: 'POST',
      body: { pluginId: 'plg-1', toolId: 'tool-1', permission: 'sometimes' },
    });
    expect(invalid.status).toBe(400);

    // A custom MCP server is added as an app: it is a connection row, and a command (no URL) has nothing to sign in to.
    const created = await call(h, '/v1/apps/custom/install', 'sess-a', {
      method: 'POST',
      body: { name: 'Local MCP', command: 'mcp-server' },
    });
    expect(created.status).toBe(201);
    const added = await parseBody(created, installView);
    expect(added.openUrl).toBeNull();
    expect(added.installation).toMatchObject({ id: added.appId, appId: added.appId, label: 'Local MCP', status: 'connected' });
    const connection = connectionView.parse(await ownerStore(store, A).get('connections', added.appId));
    expect(connection.kind).toBe('mcp');
    expect(connection.status).toBe('disconnected');
    expect(connection.endpoint).toBe('mcp-server');

    const secrets = await call(h, '/v1/plugins/secrets', 'sess-a');
    expect(secrets.status).toBe(200);
    expect(await parseBody(secrets, z.array(z.unknown()))).toEqual([]);

    const stdio = await call(h, '/v1/apps/custom/install', 'sess-a', {
      method: 'POST',
      body: { name: 'Sandbox MCP', transport: 'stdio', command: 'mcp-server', args: ['--flag'] },
    });
    expect(stdio.status).toBe(201);
    const stdioConnection = connectionView.parse(await ownerStore(store, A).get('connections', (await parseBody(stdio, installView)).appId));
    expect(stdioConnection.endpoint).toBe('mcp-server');
    expect(stdioConnection.enabled).toBe(true);

    const invalidMcp = await call(h, '/v1/apps/custom/install', 'sess-a', {
      method: 'POST',
      body: { name: 'Broken MCP' },
    });
    expect(invalidMcp.status).toBe(400);
    expect((await parseBody(invalidMcp, z.object({ error: z.object({ code: z.string() }) }))).error.code).toBe('MCP_CONFIG_INVALID');

    // Nothing was forwarded but the capability recheck that follows each app added.
    expect(h.upstream.filter((url) => !url.endsWith('/v1/capabilities/recheck'))).toHaveLength(0);
  });
});

describe('MCP env secrets (H-50)', () => {
  it('stores env values encrypted and never returns them to the client', async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
    try {
      const store = createMemoryStore();
      const h = build(store);
      const created = await call(h, '/v1/apps/custom/install', 'sess-a', {
        method: 'POST',
        body: { name: 'Env MCP', transport: 'stdio', command: 'mcp-server', env: { TOKEN: 'sk-live-123' } },
      });
      expect(created.status).toBe(201);
      const text = await created.text();
      expect(text).not.toContain('sk-live-123');
      expect(text).not.toContain('env');

      const stored = (await ownerStore(store, A).list('connections', {})).items[0];
      const envValue = z.object({ env: z.object({ TOKEN: z.string() }) }).parse(stored).env.TOKEN;
      expect(envValue.startsWith('enc:v1:')).toBe(true);
      expect(envValue).not.toContain('sk-live-123');

      const httpEnv = await call(h, '/v1/apps/custom/install', 'sess-a', {
        method: 'POST',
        body: { name: 'Http env', url: 'http://127.0.0.1:1/mcp', env: { TOKEN: 'x' } },
      });
      expect(httpEnv.status).toBe(400);
      expect((await parseBody(httpEnv, z.object({ error: z.object({ code: z.string() }) }))).error.code).toBe('MCP_ENV_STDIO_ONLY');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** RFC 4180 reader for the export: quoted cells with commas, doubled quotes and line breaks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; } else cell += ch;
  }
  return rows;
}

describe('audit initiator filters and CSV export', () => {
  const routine: AuditEntry['initiator'] = { type: 'routine', routineId: 'rt-1', occurrenceAt: '2026-10-29T08:00:00.000Z' };
  const stranger: AuditEntry['initiator'] = { type: 'channel', channel: 'telegram', conversationId: 'cvn-t', speaker: 'stranger' };

  async function seeded() {
    const store = createMemoryStore();
    const mine = ownerStore(store, A);
    await mine.put('audit', auditEntry('aud-you', { at: '2026-10-29T09:00:00.000Z' }));
    await mine.put('audit', auditEntry('aud-routine', { at: '2026-10-29T08:00:00.000Z', initiator: routine, unattended: true, agentId: 'agent-1', target: 'a@b.dev, "boss"\nsecond line', reason: 'Daily digest, needs a human' }));
    await mine.put('audit', auditEntry('aud-stranger', { at: '2026-10-29T07:00:00.000Z', initiator: stranger, unattended: true, target: '=HYPERLINK("http://x")' }));
    await ownerStore(store, B).put('audit', auditEntry('aud-other', { initiator: routine, unattended: true }));
    return build(store);
  }

  it('filters by initiator type and by unattended, scoped to the owner', async () => {
    const h = await seeded();
    const ids = async (query: string, session = 'sess-a') => (await parseBody(await call(h, '/v1/audit?' + query, session), auditView)).items.map((item) => item.id).sort();
    expect(await ids('unattended=true')).toEqual(['aud-routine', 'aud-stranger']);
    expect(await ids('unattended=false')).toEqual(['aud-you']);
    expect(await ids('initiator=routine')).toEqual(['aud-routine']);
    expect(await ids('initiator=channel&unattended=true')).toEqual(['aud-stranger']);
    expect(await ids('initiator=owner_message&unattended=true')).toEqual([]);
    expect(await ids('unattended=true', 'sess-b')).toEqual(['aud-other']);
    expect((await call(h, '/v1/audit?initiator=nobody', 'sess-a')).status).toBe(400);
  });

  it('exports the filtered rows as RFC 4180 CSV for the owner only', async () => {
    const h = await seeded();
    const res = await call(h, '/v1/audit/export.csv?unattended=true', 'sess-a');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const rows = parseCsv(await res.text());
    expect(rows[0]).toEqual(['at', 'agent', 'action', 'target', 'decision', 'reason', 'rule', 'initiator', 'unattended', 'runId', 'requestId']);
    expect(rows).toHaveLength(3);
    // Newest first; commas, quotes and a line break survive the round trip; a formula-looking cell is defused.
    expect(rows[1]).toEqual(['2026-10-29T08:00:00.000Z', 'agent-1', 'Send email', 'a@b.dev, "boss"\nsecond line', 'asked', 'Daily digest, needs a human', '', 'routine', 'true', '', '']);
    expect(rows[2]?.[3]).toBe('\'=HYPERLINK("http://x")');
    expect(rows[2]?.[7]).toBe('channel');
    const other = parseCsv(await (await call(h, '/v1/audit/export.csv', 'sess-b')).text());
    expect(other.slice(1).map((row) => row[0])).toHaveLength(1);
  });

  it('stops at the row limit and says so in a trailing comment line', async () => {
    const store = createMemoryStore();
    const mine = ownerStore(store, A);
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    for (let i = 0; i < 10_001; i += 1) await mine.put('audit', auditEntry('aud-' + String(i).padStart(5, '0'), { at: new Date(base + i * 1000).toISOString() }));
    const res = await call(build(store), '/v1/audit/export.csv', 'sess-a');
    const lines = (await res.text()).split('\r\n');
    expect(lines).toHaveLength(1 + 10_000 + 1 + 1);
    expect(lines[10_001]).toMatch(/^# truncated: the newest 10000 rows/);
    expect(lines[1]).toContain(new Date(base + 10_000 * 1000).toISOString());
  }, 60_000);
});

describe('app-owned activity', () => {
  it('reads the audit projection and aggregates usage from the owner runs', async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await ownerStore(store, A).put('audit', auditEntry('aud-1'));
    await ownerStore(store, A).put('audit', { ...auditEntry('aud-2'), agentId: 'agent-2', runId: 'run-9', action: 'tool.policy' }, { agentId: 'agent-2', runId: 'run-9', kind: 'tool.policy' });
    await ownerStore(store, A).put('runs', runDoc('run-1', 'agent-1', now, 10));
    await ownerStore(store, A).put('runs', runDoc('run-2', 'agent-1', now, 5));
    await ownerStore(store, B).put('runs', runDoc('run-3', 'agent-2', now, 100));
    const h = build(store);

    const audit = await parseBody(await call(h, '/v1/audit', 'sess-a'), auditView);
    expect(audit.items.map((item) => item.id).sort()).toEqual(['aud-1', 'aud-2']);
    // H-57: filter by agent, run and action.
    for (const query of ['agentId=agent-2', 'runId=run-9', 'action=tool.policy']) {
      expect((await parseBody(await call(h, '/v1/audit?' + query, 'sess-a'), auditView)).items.map((item) => item.id), query).toEqual(['aud-2']);
    }
    expect((await parseBody(await call(h, '/v1/audit', 'sess-b'), auditView)).items).toEqual([]);

    const usage = await parseBody(await call(h, '/v1/usage', 'sess-a'), usageView);
    expect(usage.week.inputTokens).toBe(15);
    expect(usage.byAgent).toEqual([
      { agentId: 'agent-1', runs: 2, inputTokens: 15, outputTokens: 15, computeSeconds: 2, costUsd: 1 },
    ]);
    expect(usage.byApp).toEqual([]);

    expect((await parseBody(await call(h, '/v1/usage', 'sess-b'), usageView)).week.inputTokens).toBe(100);
    expect(h.upstream).toHaveLength(0);
  });

  it('lists the usage ledger newest first with paging, an agent filter, per-model totals and owner isolation', async () => {
    const store = createMemoryStore();
    const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
    await ownerStore(store, A).put('runs', runDoc('run-1', 'agent-1', at(1), 10, { model: 'model-x' }), { agentId: 'agent-1' });
    await ownerStore(store, A).put('runs', runDoc('run-2', 'agent-2', at(2), 5, { model: 'model-y', conversationId: 'conv-1' }), { agentId: 'agent-2' });
    await ownerStore(store, A).put('runs', runDoc('run-3', 'agent-1', at(3), 20, { model: 'model-x', parentRunId: 'run-1', finishedAt: at(4) }), { agentId: 'agent-1' });
    await ownerStore(store, A).put('runs', runDoc('run-4', 'agent-1', at(0), 1), { agentId: 'agent-1' });
    await ownerStore(store, B).put('runs', runDoc('run-b', 'agent-1', at(5), 100, { model: 'model-x' }), { agentId: 'agent-1' });
    const h = build(store);

    const all = await parseBody(await call(h, '/v1/usage/ledger', 'sess-a'), ledgerView);
    expect(all.items.map((item) => item.runId)).toEqual(['run-3', 'run-2', 'run-1', 'run-4']);
    expect(all.items[0]).toMatchObject({ parentRunId: 'run-1', model: 'model-x', inputTokens: 20, outputTokens: 20, costUsd: 0.5 });
    expect(all.items[0]?.startedAt).toBe(at(3));
    expect(all.items[3]?.model).toBeUndefined();
    expect(all.nextCursor).toBeNull();
    expect(all.byModel).toEqual([
      { model: 'model-x', runs: 2, inputTokens: 30, costUsd: 1 },
      { model: 'model-y', runs: 1, inputTokens: 5, costUsd: 0.5 },
      { model: 'unknown', runs: 1, inputTokens: 1, costUsd: 0.5 },
    ]);

    // Paging: the cursor continues where the page stopped, and the model totals do not shrink.
    const first = await parseBody(await call(h, '/v1/usage/ledger?limit=3', 'sess-a'), ledgerView);
    expect(first.items.map((item) => item.runId)).toEqual(['run-3', 'run-2', 'run-1']);
    expect(first.nextCursor).not.toBeNull();
    const second = await parseBody(await call(h, '/v1/usage/ledger?limit=3&cursor=' + encodeURIComponent(first.nextCursor ?? ''), 'sess-a'), ledgerView);
    expect(second.items.map((item) => item.runId)).toEqual(['run-4']);
    expect(second.byModel).toEqual(first.byModel);

    const filtered = await parseBody(await call(h, '/v1/usage/ledger?agentId=agent-2', 'sess-a'), ledgerView);
    expect(filtered.items.map((item) => item.runId)).toEqual(['run-2']);
    expect(filtered.byModel).toEqual([{ model: 'model-y', runs: 1, inputTokens: 5, costUsd: 0.5 }]);

    const other = await parseBody(await call(h, '/v1/usage/ledger', 'sess-b'), ledgerView);
    expect(other.items.map((item) => item.runId)).toEqual(['run-b']);
    expect(other.byModel.map((entry) => entry.model)).toEqual(['model-x']);
    expect(h.upstream).toHaveLength(0);
  });
});

describe('app-owned settings models', () => {
  const modelsView = z.object({
    models: z.object({ defaultModel: z.string().nullable() }).optional(),
  });

  it('persists the account model choice, isolates owners and resets to null', async () => {
    const store = createMemoryStore();
    const loader = catalogLoader(['model-a', 'model-b']);
    const first = build(store, { modelsLoader: loader });

    const initial = await parseBody(await call(first, '/v1/settings', 'sess-a'), modelsView);
    expect(initial.models?.defaultModel ?? null).toBe(null);

    const patched = await call(first, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { models: { defaultModel: 'model-b' } },
    });
    expect(patched.status).toBe(200);
    expect((await parseBody(patched, modelsView)).models?.defaultModel).toBe('model-b');

    const second = build(store, { modelsLoader: loader });
    expect((await parseBody(await call(second, '/v1/settings', 'sess-a'), modelsView)).models?.defaultModel).toBe(
      'model-b',
    );
    expect(
      (await parseBody(await call(second, '/v1/settings', 'sess-b'), modelsView)).models?.defaultModel ?? null,
    ).toBe(null);

    const reset = await call(second, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { models: { defaultModel: null } },
    });
    expect(reset.status).toBe(200);
    expect((await parseBody(reset, modelsView)).models?.defaultModel).toBe(null);
    expect(
      (await parseBody(await call(second, '/v1/settings', 'sess-b'), modelsView)).models?.defaultModel ?? null,
    ).toBe(null);

    expect(first.upstream).toHaveLength(0);
    expect(second.upstream).toHaveLength(0);
  });

  it('rejects an unknown model without changing storage', async () => {
    const store = createMemoryStore();
    const h = build(store, { modelsLoader: catalogLoader(['model-a', 'model-b']) });

    const rejected = await call(h, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { models: { defaultModel: 'model-ghost' } },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: { code: 'UNKNOWN_MODEL', message: 'Unknown model' } });
    expect((await parseBody(await call(h, '/v1/settings', 'sess-a'), modelsView)).models?.defaultModel ?? null).toBe(
      null,
    );
    expect(h.upstream).toHaveLength(0);
  });

  it('returns 503 without saving when the catalog is unavailable', async () => {
    const store = createMemoryStore();
    const failing: ModelCatalogLoader = async () => {
      throw new Error('agentd down');
    };
    const h = build(store, { modelsLoader: failing });

    const rejected = await call(h, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { models: { defaultModel: 'model-a' } },
    });
    expect(rejected.status).toBe(503);
    const body = await rejected.json();
    expect(body).toEqual({
      error: { code: 'MODEL_CATALOG_UNAVAILABLE', message: 'Model catalog is unavailable' },
    });
    expect((await parseBody(await call(h, '/v1/settings', 'sess-a'), modelsView)).models?.defaultModel ?? null).toBe(
      null,
    );
    expect(h.upstream).toHaveLength(0);
  });

  it('resets to null offline even when the catalog is unavailable', async () => {
    const store = createMemoryStore();
    const loader = catalogLoader(['model-a']);
    const h = build(store, { modelsLoader: loader });
    expect(
      (
        await call(h, '/v1/settings', 'sess-a', {
          method: 'PATCH',
          body: { models: { defaultModel: 'model-a' } },
        })
      ).status,
    ).toBe(200);

    const offline = build(store, {
      modelsLoader: async () => {
        throw new Error('agentd down');
      },
    });
    const reset = await call(offline, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { models: { defaultModel: null } },
    });
    expect(reset.status).toBe(200);
    expect((await parseBody(reset, modelsView)).models?.defaultModel).toBe(null);
    expect(offline.upstream).toHaveLength(0);
  });

  it('rejects an empty account model choice', async () => {
    const store = createMemoryStore();
    const h = build(store);
    expect(
      (
        await call(h, '/v1/settings', 'sess-a', {
          method: 'PATCH',
          body: { models: { defaultModel: '' } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(h, '/v1/settings', 'sess-a', {
          method: 'PATCH',
          body: { models: { defaultModel: '   ' } },
        })
      ).status,
    ).toBe(400);
    expect((await parseBody(await call(h, '/v1/settings', 'sess-a'), modelsView)).models?.defaultModel ?? null).toBe(
      null,
    );
    expect(h.upstream).toHaveLength(0);
  });

  it('fetches the catalog with a live abort signal and saves a known model', async () => {
    const store = createMemoryStore();
    const seen: { signal: unknown } = { signal: null };
    const agentdFetch: typeof fetch = async (input, init) => {
      seen.signal = init?.signal ?? null;
      expect(seen.signal instanceof AbortSignal ? seen.signal.aborted : true).toBe(false);
      return Response.json({
        defaultModel: 'model-a',
        items: [
          { id: 'model-a', name: 'Model A', supportsImages: false },
          { id: 'model-b', name: 'Model B', supportsImages: true },
        ],
      });
    };
    const h = build(store, {
      modelsLoader: createAgentdModelCatalogLoader({
        agentdUrl: UPSTREAM,
        internalToken: SERVICE_TOKEN,
        fetchFn: agentdFetch,
      }),
    });
    const patched = await call(h, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { models: { defaultModel: 'model-b' } },
    });
    expect(patched.status).toBe(200);
    expect((await parseBody(patched, modelsView)).models?.defaultModel).toBe('model-b');
    expect(seen.signal instanceof AbortSignal).toBe(true);
    expect(h.upstream).toHaveLength(0);
  });

  it('surfaces a rejected catalog fetch as 503 without saving or leaking detail', async () => {
    const store = createMemoryStore();
    const agentdFetch: typeof fetch = async () => {
      throw new Error('socket hang up at 10.0.0.9:8788');
    };
    const h = build(store, {
      modelsLoader: createAgentdModelCatalogLoader({
        agentdUrl: UPSTREAM,
        internalToken: SERVICE_TOKEN,
        fetchFn: agentdFetch,
      }),
    });
    const rejected = await call(h, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { models: { defaultModel: 'model-a' } },
    });
    expect(rejected.status).toBe(503);
    const body = await rejected.json();
    expect(body).toEqual({
      error: { code: 'MODEL_CATALOG_UNAVAILABLE', message: 'Model catalog is unavailable' },
    });
    expect(JSON.stringify(body)).not.toContain('socket hang up');
    expect((await parseBody(await call(h, '/v1/settings', 'sess-a'), modelsView)).models?.defaultModel ?? null).toBe(
      null,
    );
    expect(h.upstream).toHaveLength(0);
  });

  it('aborts a hanging catalog fetch instead of hanging the save', async () => {
    const store = createMemoryStore();
    const agentdFetch: typeof fetch = (input, init) =>
      new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), {
          once: true,
        });
      });
    const h = build(store, {
      modelsLoader: createAgentdModelCatalogLoader({
        agentdUrl: UPSTREAM,
        internalToken: SERVICE_TOKEN,
        fetchFn: agentdFetch,
        timeoutMs: 50,
      }),
    });
    const started = Date.now();
    const rejected = await call(h, '/v1/settings', 'sess-a', {
      method: 'PATCH',
      body: { models: { defaultModel: 'model-a' } },
    });
    expect(rejected.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await parseBody(await call(h, '/v1/settings', 'sess-a'), modelsView)).models?.defaultModel ?? null).toBe(
      null,
    );
    expect(h.upstream).toHaveLength(0);
  });
});

describe('gateway models', () => {
  it('requires auth and forwards only GET /v1/models upstream', async () => {
    const store = createMemoryStore();
    const h = build(store);

    expect((await h.app.request('/v1/models')).status).toBe(401);
    expect(h.upstream).toHaveLength(0);

    const catalog = await call(h, '/v1/models', 'sess-a');
    expect(catalog.status).toBe(200);
    expect(h.upstream).toEqual([UPSTREAM + '/v1/models']);

    expect((await call(h, '/v1/models', 'sess-a', { method: 'POST', body: {} })).status).toBe(404);
    expect(h.upstream).toHaveLength(1);
  });
});

describe('public routing', () => {
  it('forwards the goal and feed routes for their declared methods only', async () => {
    const h = build(createMemoryStore());
    expect((await call(h, '/v1/goals', 'sess-a', { method: 'POST', body: { agentId: 'agent-1', kind: 'goal', title: 't' } })).status).toBe(200);
    expect((await call(h, '/v1/goals/goal-1', 'sess-a')).status).toBe(200);
    expect((await call(h, '/v1/feed?agentId=agent-1', 'sess-a')).status).toBe(200);
    expect((await call(h, '/v1/feed/feed-1/like', 'sess-a', { method: 'POST', body: { liked: true } })).status).toBe(200);
    expect((await call(h, '/v1/feed', 'sess-a', { method: 'POST', body: {} })).status).toBe(404);
    expect((await call(h, '/v1/feed/feed-1', 'sess-a', { method: 'PATCH', body: {} })).status).toBe(404);
    expect(h.upstream).toEqual([
      UPSTREAM + '/v1/goals',
      UPSTREAM + '/v1/goals/goal-1',
      UPSTREAM + '/v1/feed?agentId=agent-1',
      UPSTREAM + '/v1/feed/feed-1/like',
    ]);
  });

  it('forwards device registration for its declared methods only', async () => {
    const h = build(createMemoryStore());
    const token = 'ab'.repeat(32);
    expect((await call(h, '/v1/devices', 'sess-a', { method: 'POST', body: { platform: 'ios', token, environment: 'sandbox', bundleId: 'io.github.nigelleong0703.juno' } })).status).toBe(200);
    expect((await call(h, '/v1/devices/' + token, 'sess-a', { method: 'DELETE' })).status).toBe(200);
    expect((await call(h, '/v1/devices/' + token, 'sess-a', { method: 'GET' })).status).toBe(404);
    expect(h.upstream).toEqual([UPSTREAM + '/v1/devices', UPSTREAM + '/v1/devices/' + token]);
  });

  it('serves app routes locally and forwards only declared agentd routes', async () => {
    const store = createMemoryStore();
    const h = build(store);

    for (const path of ['/v1/settings', '/v1/plugins', '/v1/library', '/v1/audit', '/v1/usage', '/v1/usage/ledger']) {
      expect((await call(h, path, 'sess-a')).status, path).toBe(200);
    }
    expect(h.upstream).toHaveLength(0);

    expect((await call(h, '/v1/agents', 'sess-a')).status).toBe(200);
    expect(h.upstream).toEqual([UPSTREAM + '/v1/agents']);

    expect((await call(h, '/v1/models', 'sess-a')).status).toBe(200);
    expect(h.upstream).toEqual([UPSTREAM + '/v1/agents', UPSTREAM + '/v1/models']);

    expect((await call(h, '/v1/undeclared', 'sess-a')).status).toBe(404);
    expect((await call(h, '/v1/workspaces', 'sess-a', { method: 'POST', body: {} })).status).toBe(404);
    expect((await call(h, '/v1/conversations/c1/items', 'sess-a', { method: 'POST', body: {} })).status).toBe(404);
    expect(h.upstream).toHaveLength(2);

    expect((await h.app.request('/v1/settings')).status).toBe(401);
    expect((await h.app.request('/v1/agents')).status).toBe(401);
    expect((await h.app.request('/v1/models')).status).toBe(401);
  });

  it('forwards the role-suggestion accept and dismiss routes only as POST (BACKEND §10.11)', async () => {
    const h = build(createMemoryStore());
    const actions = ['accept', 'dismiss'];
    for (const action of actions) {
      const path = '/v1/agents/agt-1/role-suggestion/' + action;
      expect((await call(h, path, 'sess-a', { method: 'POST', body: {} })).status).toBe(200);
      expect((await call(h, path, 'sess-a')).status).toBe(404);
    }
    expect(h.upstream).toEqual(actions.map((action) => UPSTREAM + '/v1/agents/agt-1/role-suggestion/' + action));
  });
});
