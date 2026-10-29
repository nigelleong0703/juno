/**
 * Google consumer connectors e2e on loopback, with the built-in catalog entries (only the Google-run MCP urls
 * point at a fixture). The fixture plays Google: an authorization server (PKCE), the YouTube Data and Tasks
 * APIs, and a Google-style MCP server that answers an unauthenticated initialize and refuses tool calls without a token
 * (as people does). Per service: catalog -> connect -> sign in with the entry's scopes -> connected ->
 * the agent sees the tools and one real call returns data. YouTube (public, on the deployment key and connected by
 * default; and the owner's own account) and Tasks run on the MCP server
 * this gateway hosts (modules/google-mcp.ts), reached through the gateway itself; so do Gmail, Calendar and Drive
 * (the fixture serves the parts of their REST APIs the tools use).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createMcpManager, mcpToolsForAgent } from '@agent-desktop/contracts/mcp';
import { installAppResponseSchema } from '@agent-desktop/public-contracts';
import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';
import { CONNECTOR_CATALOG } from './builtin-catalog.js';

const OWNER = 'owner-a';
const AGENT = 'agent-a';
const PUBLIC_URL = 'https://api.test';
const CALLBACK = PUBLIC_URL + '/oauth/mcp/callback';
/** The phone reaches the API on another origin (Tailscale serve), listed in PUBLIC_ORIGINS. */
const PHONE_ORIGIN = 'https://phone.test:8443';
const YOUTUBE_KEY = 'test-youtube-key';

interface Fixture { base: string; drafts: string[]; scopes: string[]; redirects: { authorize: string; token: string }[]; youtubeQueries: URLSearchParams[]; tasks: Record<string, unknown>[]; close(): Promise<void> }

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const GOOGLE_STYLE_TOOLS: Record<string, { name: string; text: string }> = {
  '/people/mcp/v1': { name: 'search_contacts', text: 'Ada Lovelace <ada@example.com>' },
};

function startGoogle(): Promise<Fixture> {
  const codes = new Map<string, string>();
  const tokens = new Set<string>();
  const scopes: string[] = [];
  const drafts: string[] = [];
  const redirects: { authorize: string; token: string }[] = [];
  const authorizeRedirect = new Map<string, string>();
  const youtubeQueries: URLSearchParams[] = [];
  const tasks: Record<string, unknown>[] = [{ id: 't1', title: 'Buy milk', status: 'needsAction' }];
  let base = '';
  const authorized = (req: IncomingMessage) => tokens.has((req.headers.authorization ?? '').slice('Bearer '.length));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', code_challenge_methods_supported: ['plain', 'S256'] });
    }
    if (req.method === 'POST' && url.pathname === '/register') return json(res, 201, { client_id: 'fixture-client' });
    if (req.method === 'GET' && url.pathname === '/authorize') {
      scopes.push(url.searchParams.get('scope') ?? '');
      const code = randomUUID();
      codes.set(code, url.searchParams.get('code_challenge') ?? '');
      authorizeRedirect.set(code, url.searchParams.get('redirect_uri') ?? '');
      res.writeHead(302, { location: CALLBACK + '?' + new URLSearchParams({ code, state: url.searchParams.get('state') ?? '' }).toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      const challenge = codes.get(form.get('code') ?? '');
      if (challenge === undefined || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) return json(res, 400, { error: 'invalid_grant' });
      redirects.push({ authorize: authorizeRedirect.get(form.get('code') ?? '') ?? '', token: form.get('redirect_uri') ?? '' });
      const access = 'ya29.' + randomUUID();
      tokens.add(access);
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: '1//' + randomUUID() });
    }
    // YouTube Data API v3.
    if (req.method === 'GET' && url.pathname.startsWith('/youtube/v3/')) {
      // The public server sends the deployment's key, the account server the owner's token.
      if (url.searchParams.get('key') !== YOUTUBE_KEY && !authorized(req)) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
      youtubeQueries.push(url.searchParams);
      if (url.pathname === '/youtube/v3/search') {
        return json(res, 200, { items: [{ id: { kind: 'youtube#video', videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Never Gonna Give You Up', channelTitle: 'Rick Astley', publishedAt: '2009-10-25T06:57:33Z' } }] });
      }
      if (url.pathname === '/youtube/v3/videos' && url.searchParams.get('chart') === 'mostPopular') {
        return json(res, 200, { items: [{ id: 'abc123XYZ_-', snippet: { title: 'Chart Topper', channelTitle: 'Chan', publishedAt: '2026-10-16T08:00:00Z' }, statistics: { viewCount: '1234567' } }] });
      }
      if (url.pathname === '/youtube/v3/videos' && url.searchParams.get('myRating') === 'like') {
        return json(res, 200, { items: [{ id: 'liked1', snippet: { title: 'Liked Song', channelTitle: 'Chan', categoryId: '10' } }, { id: 'liked2', snippet: { title: 'Liked Talk', channelTitle: 'Chan', categoryId: '27' } }] });
      }
      return json(res, 200, { items: [] });
    }
    // Google Tasks API: the default list, list and insert.
    if (url.pathname.startsWith('/tasks/v1/')) {
      if (!authorized(req)) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
      if (req.method === 'GET' && url.pathname === '/tasks/v1/users/@me/lists') return json(res, 200, { items: [{ id: '@default', title: 'My Tasks' }] });
      if (url.pathname === '/tasks/v1/lists/%40default/tasks' || url.pathname === '/tasks/v1/lists/@default/tasks') {
        if (req.method === 'GET') return json(res, 200, { items: tasks });
        const created = { id: 't' + String(tasks.length + 1), status: 'needsAction', ...(JSON.parse(await readBody(req)) as Record<string, unknown>) };
        tasks.push(created);
        return json(res, 200, created);
      }
    }
    // Gmail, Calendar and Drive REST APIs (the parts the hosted tools use).
    if (/^\/(gmail|calendar|drive)\//.test(url.pathname)) {
      if (!authorized(req)) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
      const b64 = (text: string) => Buffer.from(text).toString('base64url');
      const message = { id: 'm1', threadId: 't1', snippet: 'Lunch on Friday?', labelIds: ['INBOX'], payload: {
        mimeType: 'multipart/alternative', filename: '', headers: [{ name: 'From', value: 'Ada <ada@example.com>' }, { name: 'Subject', value: 'Lunch' }, { name: 'X-Other', value: 'x' }],
        parts: [{ mimeType: 'text/plain', filename: '', body: { data: b64('Lunch on Friday at noon?') } }, { mimeType: 'application/pdf', filename: 'menu.pdf', body: { size: 10 } }],
      } };
      if (url.pathname === '/gmail/v1/users/me/messages') return json(res, 200, { messages: [{ id: 'm1', threadId: 't1' }] });
      if (url.pathname === '/gmail/v1/users/me/messages/m1') return json(res, 200, message);
      if (url.pathname === '/gmail/v1/users/me/drafts' && req.method === 'POST') {
        drafts.push(Buffer.from((JSON.parse(await readBody(req)) as { message: { raw: string } }).message.raw, 'base64url').toString('utf8'));
        return json(res, 200, { id: 'd1', message: { id: 'm2', threadId: 't2' } });
      }
      if (url.pathname === '/calendar/v3/calendars/primary/events') {
        return json(res, 200, { timeZone: 'Asia/Singapore', items: [{ id: 'e1', summary: 'Dentist', start: { dateTime: '2026-10-20T09:00:00+08:00' }, end: { dateTime: '2026-10-20T10:00:00+08:00' } }] });
      }
      if (url.pathname === '/drive/v3/files/doc1') return json(res, 200, { id: 'doc1', name: 'Trip plan', mimeType: 'application/vnd.google-apps.document' });
      if (url.pathname === '/drive/v3/files/doc1/export' && url.searchParams.get('mimeType') === 'text/plain') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('Day 1: Kyoto');
      }
    }
    // Google-run MCP servers: path-aware resource metadata naming the fixture as authorization server.
    const prm = url.pathname.replace('/.well-known/oauth-protected-resource', '');
    if (req.method === 'GET' && prm in GOOGLE_STYLE_TOOLS) {
      return json(res, 200, { resource: base + prm, authorization_servers: [base + '/'], bearer_methods_supported: ['header'] });
    }
    const tool = GOOGLE_STYLE_TOOLS[url.pathname];
    if (req.method === 'POST' && tool !== undefined) {
      const message = JSON.parse(await readBody(req)) as { id?: string | number; method: string };
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      // Like Google: initialize and tools/list answer without a token; a tool call needs one.
      if (message.method === 'initialize') return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'StatelessServer', version: '1' } } });
      if (message.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: tool.name, description: tool.name, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] } });
      if (message.method === 'tools/call') {
        const text = authorized(req) ? tool.text : "Method doesn't allow unregistered callers";
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }], ...(authorized(req) ? {} : { isError: true }) } });
      }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port);
      resolve({ base, drafts, scopes, redirects, youtubeQueries, tasks, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

const auth: ApiAuth = {
  info: { mode: 'account', providers: ['credential'] },
  handle: async () => new Response('auth', { status: 200 }),
  resolve: async (request) => (request.headers.get('authorization') === 'Bearer a' ? { ownerId: OWNER } : null),
};

describe('Google consumer connectors e2e (loopback Google)', () => {
  let google: Fixture;
  let store: Store;
  let app: ReturnType<typeof createApiApp>;
  /** The gateway's own origin goes to the app in-process; everything else to the network. */
  let routed: typeof fetch;
  const previousKey = process.env.SECRETS_KEY;
  const previousPrivateHosts = process.env.MCP_ALLOW_PRIVATE_HOSTS;
  const previousYoutube = { key: process.env.YOUTUBE_API_KEY, url: process.env.BETTER_AUTH_URL, token: process.env.INTERNAL_AGENTD_TOKEN };

  beforeAll(async () => {
    process.env.SECRETS_KEY = randomBytes(32).toString('base64');
    process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
    process.env.YOUTUBE_API_KEY = YOUTUBE_KEY;
    process.env.BETTER_AUTH_URL = PUBLIC_URL;
    process.env.INTERNAL_AGENTD_TOKEN = 'service-token';
    google = await startGoogle();
    store = createMemoryStore();
    await store.forOwner?.(OWNER)?.put('agents', { id: AGENT, name: 'Agent A', pluginIds: [], ownerId: OWNER } as never);
    const fixtureUrls: Record<string, string> = { 'google-contacts': google.base + '/people/mcp/v1' };
    const catalog = CONNECTOR_CATALOG.map((entry) => (entry.id in fixtureUrls ? { ...entry, url: fixtureUrls[entry.id] ?? entry.url } : entry));
    routed = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith(PUBLIC_URL) ? Promise.resolve(app.request(url, init)) : fetch(input, init);
    };
    app = createApiApp({
      auth, agentdUrl: 'http://127.0.0.1:1', internalToken: 'service-token',
      fetch: async () => Response.json({ items: [] }),
      store, blobs: createMemoryBlobStore(), publicUrl: PUBLIC_URL, connectorCatalog: catalog,
      mcpOAuth: { returnUrl: 'http://web.test/connectors', env: { GOOGLE_OAUTH_CLIENT_ID: 'google-client', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret', PUBLIC_ORIGINS: PHONE_ORIGIN, YOUTUBE_API_KEY: YOUTUBE_KEY, BETTER_AUTH_URL: PUBLIC_URL }, fetch: routed },
      googleMcp: { issuer: google.base, env: { YOUTUBE_API_KEY: YOUTUBE_KEY }, apis: { gmail: google.base + '/gmail/v1', calendar: google.base + '/calendar/v3', drive: google.base + '/drive/v3', youtube: google.base + '/youtube/v3', tasks: google.base + '/tasks/v1' } },
    });
  });

  afterAll(async () => {
    await google.close();
    if (previousKey === undefined) delete process.env.SECRETS_KEY; else process.env.SECRETS_KEY = previousKey;
    if (previousPrivateHosts === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS; else process.env.MCP_ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
    if (previousYoutube.key === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = previousYoutube.key;
    if (previousYoutube.url === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = previousYoutube.url;
    if (previousYoutube.token === undefined) delete process.env.INTERNAL_AGENTD_TOKEN; else process.env.INTERNAL_AGENTD_TOKEN = previousYoutube.token;
  });

  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> => Promise.resolve(app.request(path, {
    method,
    headers: { Authorization: 'Bearer a', ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

  /** The owner's connection rows of an app, oldest first: its accounts. */
  const accountsOf = async (catalogId: string): Promise<string[]> => {
    const scoped = store.forOwner?.(OWNER);
    if (!scoped) throw new Error('missing forOwner');
    return (await scoped.list('connections', { limit: 200 })).items.filter((row) => row.catalogId === catalogId).map((row) => row.id);
  };

  /** Adds an app through the stubbed Google sign-in; returns the new account's connection id and where the browser was sent at the end. */
  async function connectTo(catalogId: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ connectionId: string; returned: URL }> {
    const before = await accountsOf(catalogId);
    const started = await call('/v1/apps/' + catalogId + '/install', 'POST', body, headers);
    expect(started.status).toBe(201);
    const { openUrl, installation } = installAppResponseSchema.parse(await started.json());
    // Google-run servers answer initialize without a token; the entry still signs in.
    expect(installation).toBeNull();
    expect(openUrl).not.toBeNull();
    const toGoogle = await fetch(openUrl ?? '', { redirect: 'manual' });
    const callback = new URL(toGoogle.headers.get('location') ?? '');
    const done = await app.request(callback.pathname + callback.search);
    const returned = new URL(done.headers.get('location') ?? '');
    expect(returned.searchParams.get('status')).toBe('connected');
    return { connectionId: (await accountsOf(catalogId)).find((id) => !before.includes(id)) ?? '', returned };
  }

  async function connect(catalogId: string, headers: Record<string, string> = {}): Promise<string> {
    const { connectionId, returned } = await connectTo(catalogId, headers);
    expect(returned.origin + returned.pathname).toBe('http://web.test/connectors');
    return connectionId;
  }

  /** `modelName`, when given, is the name the model sees for the tool: `<connector>_<tool>`. */
  async function agentCall(connectionId: string, toolName: string, args: Record<string, unknown>, modelName?: string): Promise<string> {
    const scoped = store.forOwner?.(OWNER);
    if (!scoped) throw new Error('missing forOwner');
    const manager = createMcpManager({ fetchImpl: routed });
    const names = (await mcpToolsForAgent(manager, scoped, AGENT, new Set())).map((tool) => tool.name);
    expect(names, names.join(',')).toContainEqual(modelName ?? expect.stringContaining(toolName));
    const result = await manager.callTool({ ownerId: OWNER, store: scoped, agentId: AGENT, connectionId, toolName, args });
    return JSON.stringify(result);
  }

  it('serves the public YouTube endpoint only with the internal service token (403, not 401, otherwise)', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const post = (headers: Record<string, string>) => Promise.resolve(app.request('/mcp/google/youtube', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(list) }));
    const wrong: Array<Record<string, string>> = [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer a' }];
    for (const headers of wrong) {
      const denied = await post(headers);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: { code: 'FORBIDDEN' } });
    }
    const served = await post({ authorization: 'Bearer service-token' });
    expect(served.status).toBe(200);
    expect(JSON.stringify(await served.json())).toContain('"name":"search"');
  });

  it('each app signs in with its scopes and serves a real tool call', async () => {
    // Nothing is added yet but the public YouTube, which needs no sign-in: on by default, connected the first time anything reads the owner's apps (here the agent's tools).
    for (const id of ['youtube-account', 'google-tasks', 'google-contacts', 'gmail', 'google-calendar', 'google-drive', 'google-maps']) expect(await accountsOf(id)).toEqual([]);
    const scopedOwner = store.forOwner?.(OWNER);
    if (!scopedOwner) throw new Error('missing forOwner');
    await mcpToolsForAgent(createMcpManager({ fetchImpl: routed }), scopedOwner, AGENT, new Set());
    const youtube = (await accountsOf('youtube'))[0] ?? '';
    expect(youtube).not.toBe('');
    const found = await agentCall(youtube, 'search', { query: 'rick astley' }, 'youtube_search');
    expect(found).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(google.youtubeQueries.at(-1)?.get('q')).toBe('rick astley');
    expect(google.youtubeQueries.at(-1)?.get('key')).toBe(YOUTUBE_KEY);
    await agentCall(youtube, 'search', { query: 'news', order: 'date', regionCode: 'SG', publishedAfter: '2026-10-11T00:00:00Z', videoDuration: 'short', relevanceLanguage: 'zh-Hans', eventType: 'live', channelId: 'UC123' });
    expect(Object.fromEntries(google.youtubeQueries.at(-1) ?? [])).toMatchObject({ order: 'date', regionCode: 'SG', publishedAfter: '2026-10-11T00:00:00Z', videoDuration: 'short', relevanceLanguage: 'zh-Hans', eventType: 'live', channelId: 'UC123' });
    const popular = await agentCall(youtube, 'list_popular', { regionCode: 'SG', videoCategoryId: '10' }, 'youtube_list_popular');
    expect(popular).toContain('https://www.youtube.com/watch?v=abc123XYZ_-');
    expect(popular).toContain('1234567');
    expect(popular).toContain('2026-10-16T08:00:00Z');
    expect(Object.fromEntries(google.youtubeQueries.at(-1) ?? [])).toMatchObject({ chart: 'mostPopular', regionCode: 'SG', videoCategoryId: '10', part: 'snippet,statistics' });
    expect(await agentCall(youtube, 'search_music', { query: 'never gonna give you up' }, 'youtube_search_music')).toContain('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(google.youtubeQueries.at(-1)?.get('videoCategoryId')).toBe('10');
    await agentCall(youtube, 'search_music', { query: 'new', order: 'date', publishedAfter: '2026-10-11T00:00:00Z', regionCode: 'SG' });
    expect(Object.fromEntries(google.youtubeQueries.at(-1) ?? [])).toMatchObject({ videoCategoryId: '10', order: 'date', publishedAfter: '2026-10-11T00:00:00Z', regionCode: 'SG' });
    expect(await agentCall(youtube, 'list_popular_music', { regionCode: 'SG' }, 'youtube_list_popular_music')).toContain('https://music.youtube.com/watch?v=abc123XYZ_-');
    expect(Object.fromEntries(google.youtubeQueries.at(-1) ?? [])).toMatchObject({ chart: 'mostPopular', regionCode: 'SG', videoCategoryId: '10' });

    const account = await connect('youtube-account');
    expect(google.scopes.at(-1)).toBe('https://www.googleapis.com/auth/youtube.readonly');
    const liked = await agentCall(account, 'list_liked_music', {}, 'youtube_account_list_liked_music');
    expect(liked).toContain('Liked Song');
    expect(liked).not.toContain('Liked Talk');

    const tasks = await connect('google-tasks');
    expect(google.scopes.at(-1)).toBe('https://www.googleapis.com/auth/tasks');
    expect(await agentCall(tasks, 'list_tasks', {})).toContain('Buy milk');
    // Writing is offered too (Actions ask first by default); the approval itself is the harness's builtin.mcp rule.
    expect(await agentCall(tasks, 'create_task', { title: 'Call the dentist', due: '2026-10-20T00:00:00Z' })).toContain('Call the dentist');
    expect(google.tasks.at(-1)).toMatchObject({ title: 'Call the dentist', due: '2026-10-20T00:00:00Z' });

    const contacts = await connect('google-contacts');
    expect(google.scopes.at(-1)).toBe('https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.profile');
    expect(await agentCall(contacts, 'search_contacts', { query: 'Ada' })).toContain('ada@example.com');

    for (const id of ['youtube', 'youtube-account', 'google-tasks', 'google-contacts']) {
      const rows = (await scopedOwner.list('connections', { limit: 200 })).items.filter((row) => row.catalogId === id);
      expect(rows.map((row) => row.status), id).toEqual(['connected']);
    }
  });

  it('Gmail, Calendar and Drive on the REST APIs; a sign-in from the phone returns to the phone origin, the app gets the browser back', async () => {
    // The iPhone app asks for its own scheme, which its sign-in sheet catches; the web app sends no body (connect()).
    const { connectionId: gmail, returned } = await connectTo('gmail', { 'x-forwarded-host': 'phone.test:8443', 'x-forwarded-proto': 'https' }, { returnUrl: 'juno://connectors' });
    expect(returned.toString()).toBe('juno://connectors?connection=' + gmail + '&status=connected');
    expect(google.scopes.at(-1)).toBe('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.modify');
    expect(google.redirects.at(-1)).toEqual({ authorize: PHONE_ORIGIN + '/oauth/mcp/callback', token: PHONE_ORIGIN + '/oauth/mcp/callback' });
    const found = await agentCall(gmail, 'search_messages', { query: 'lunch' });
    expect(found).toContain('ada@example.com');
    expect(found).toContain('https://mail.google.com/mail/u/0/#all/t1');
    const read = await agentCall(gmail, 'get_message', { messageId: 'm1' });
    expect(read).toContain('Lunch on Friday at noon?');
    expect(read).toContain('menu.pdf');
    // Drafting is offered (Actions ask first by default); the draft is a plain RFC 2822 message and is never sent.
    expect(await agentCall(gmail, 'create_draft', { to: 'ada@example.com', subject: 'Re: Lunch', body: 'Friday works.' })).toContain('d1');
    expect(google.drafts.at(-1)).toContain('To: ada@example.com');
    expect(google.drafts.at(-1)).toContain('Subject: Re: Lunch');

    const calendar = await connect('google-calendar');
    expect(google.scopes.at(-1)).toBe('https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events');
    expect(await agentCall(calendar, 'list_events', { timeMin: '2026-10-20T00:00:00+08:00' })).toContain('Dentist');

    const drive = await connect('google-drive');
    expect(google.scopes.at(-1)).toBe('https://www.googleapis.com/auth/drive');
    expect(await agentCall(drive, 'read_file_content', { fileId: 'doc1' })).toContain('Day 1: Kyoto');

    // An origin outside PUBLIC_ORIGINS is ignored: the callback stays on the public URL.
    await connect('youtube-account', { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' });
    expect(google.redirects.at(-1)).toEqual({ authorize: CALLBACK, token: CALLBACK });

    // A return URL outside the allow-list is refused before any sign-in starts.
    const accountsBefore = (await accountsOf('gmail')).length;
    const refused = await call('/v1/apps/gmail/install', 'POST', { returnUrl: 'https://evil.test/steal' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 'MCP_OAUTH_RETURN_URL_REFUSED' } });
    expect(await accountsOf('gmail')).toHaveLength(accountsBefore);
  });

  it('the hosted server challenges a call without a token and points at Google', async () => {
    const response = await app.request('/mcp/google/youtube-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(PUBLIC_URL + '/.well-known/oauth-protected-resource/mcp/google/youtube-account');
    const metadata = (await (await app.request('/.well-known/oauth-protected-resource/mcp/google/youtube-account')).json()) as { resource: string; authorization_servers: string[] };
    expect(metadata).toMatchObject({ resource: PUBLIC_URL + '/mcp/google/youtube-account', authorization_servers: [google.base] });
    // A token Google rejects comes back as 401, so the client refreshes or asks to reconnect.
    const rejected = await app.request('/mcp/google/youtube-account', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer revoked' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_my_playlists', arguments: {} } }) });
    expect(rejected.status).toBe(401);
  });
});
