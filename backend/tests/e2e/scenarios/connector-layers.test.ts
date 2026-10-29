import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount, stackUrls } from '../harness/client';

/** The admin token the harness gives the API (harness/stack.ts SECRETS.adminToken). */
const ADMIN_TOKEN = 'e2e-admin-token-0123456789';

/**
 * The three layers of the Apps page (BACKEND 10.18.3) through the real stack: an operator probes a URL into a hidden draft and lists it; a custom
 * MCP server is probed and confirmed before it can be added; a Composio app is connected through a stand-in for Composio (its login held there)
 * and a tool that changes afterwards is held for review.
 */

interface Tool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const json = (response: ServerResponse, value: unknown, status = 200): void => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
};

/** An MCP server: answers `initialize` and `tools/list` (the list is read per call, so a scenario can change it), and calls `check` first. */
function mcpHandler(tools: () => Tool[], check: (request: IncomingMessage) => boolean = () => true): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const body = await readBody(request);
    if (request.method !== 'POST') { response.statusCode = 204; response.end(); return; }
    if (!check(request)) { response.statusCode = 401; response.end(); return; }
    const message = JSON.parse(body) as { id?: number; method: string };
    const reply = (result: unknown): void => json(response, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
    // ttlMs 0: the list is read again whenever the Apps page asks, so a change shows at once.
    if (message.method === 'tools/list') return reply({ tools: tools(), ttlMs: 0 });
    response.statusCode = 202;
    response.end();
  };
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, port = 0): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)); });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

describe('connector layers', () => {
  const READ: Tool = { name: 'list_things', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };
  const WRITE: Tool = { name: 'make_thing', inputSchema: { type: 'object', properties: {} } };

  describe('a server by URL: probe, draft, list, and confirm', () => {
    let open: { server: Server; base: string };
    let oauthLike: { server: Server; base: string };
    beforeAll(async () => {
      open = await listen(mcpHandler(() => [READ, WRITE]));
      // A server that wants a sign-in but whose protected-resource metadata names another resource (Airtable's case): refused, not bent.
      oauthLike = await listen((request, response) => {
        if (request.url?.startsWith('/prm') === true) return json(response, { resource: 'https://elsewhere.example/mcp', authorization_servers: ['https://auth.example'] });
        response.statusCode = 401;
        response.setHeader('www-authenticate', `Bearer resource_metadata="${oauthLike.base}/prm"`);
        response.end();
        return undefined;
      });
    });
    afterAll(async () => { await close(open.server); await close(oauthLike.server); });

    const admin = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(stackUrls().apiUrl + path, { method, headers: { authorization: 'Bearer ' + ADMIN_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    };

    it('an operator probes a URL into a hidden draft that nobody sees until it is listed; a metadata mismatch is refused; a Composio slug drafts too', async () => {
      const account = await createAccount('layers-draft');
      const seen = async (id: string) => ((await account.api('GET', '/v1/apps')).body.items as Array<{ id: string; source: string; category: string }>).find((app) => app.id === id);

      const drafted = await admin('POST', '/admin/v1/apps/probe', { url: open.base + '/mcp', id: 'fixture-open', name: 'Fixture open' });
      expect(drafted.status).toBe(201);
      expect(drafted.body['app']).toMatchObject({ id: 'fixture-open', status: 'hidden', mcpServers: { 'fixture-open': { auth: 'none' } }, tools: { list_things: 'read', make_thing: 'change' } });
      expect(await seen('fixture-open')).toBeUndefined();

      expect((await admin('PATCH', '/admin/v1/apps/fixture-open', { status: 'listed' })).status).toBe(200);
      expect(await seen('fixture-open')).toMatchObject({ category: 'work', source: 'official' });

      const mismatch = await admin('POST', '/admin/v1/apps/probe', { url: oauthLike.base + '/mcp', id: 'fixture-oauth' });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body).toMatchObject({ error: { code: 'MCP_OAUTH_DISCOVERY' } });
      expect(await seen('fixture-oauth')).toBeUndefined();

      const toolkit = await admin('POST', '/admin/v1/apps/probe', { composioToolkit: 'trello', id: 'trello-composio' });
      expect(toolkit.status).toBe(201);
      expect(toolkit.body['app']).toMatchObject({ id: 'trello-composio', status: 'hidden', source: 'composio', toolkit: 'trello' });
      expect(await seen('trello-composio')).toBeUndefined();
      expect((await admin('PATCH', '/admin/v1/apps/trello-composio', { status: 'listed' })).status).toBe(200);
      expect(await seen('trello-composio')).toMatchObject({ source: 'composio' });

      // A Composio row whose toolkit a first-party row covers (Gmail) is listed by the admin but hidden from the page.
      expect((await admin('POST', '/admin/v1/apps/probe', { composioToolkit: 'gmail', id: 'gmail-composio' })).status).toBe(201);
      expect((await admin('PATCH', '/admin/v1/apps/gmail-composio', { status: 'listed' })).status).toBe(200);
      expect(await seen('gmail-composio')).toBeUndefined();
      expect(await seen('gmail')).toBeDefined();
    });

    it('a custom server is probed first; adding it needs the owner\'s confirmation, which must still match; their marks decide read versus change', async () => {
      const account = await createAccount('layers-custom');
      const probed = await account.api('POST', '/v1/apps/custom/probe', { url: open.base + '/mcp' });
      expect(probed.status).toBe(200);
      expect(probed.body).toMatchObject({ auth: 'none', usable: true, tools: [{ name: 'list_things', suggested: 'read', basis: 'annotation' }, { name: 'make_thing', suggested: 'change', basis: 'unmarked' }] });

      // Without the confirmation, or with a different login than the server now asks for, nothing is added.
      const refused = await account.api('POST', '/v1/apps/custom/install', { name: 'Fixture', url: open.base + '/mcp' });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ error: { code: 'CUSTOM_PROBE_REQUIRED' } });
      const changed = await account.api('POST', '/v1/apps/custom/install', { name: 'Fixture', url: open.base + '/mcp', confirm: { auth: 'oauth', tools: {} } });
      expect(changed.status).toBe(409);
      expect(changed.body).toMatchObject({ error: { code: 'CUSTOM_PROBE_CHANGED' } });
      expect(((await account.api('GET', '/v1/apps')).body.items as Array<{ category: string }>).filter((app) => app.category === 'custom')).toHaveLength(0);

      // The owner flips list_things to a change; the page's capability list shows their marks.
      const added = await account.api('POST', '/v1/apps/custom/install', { name: 'Fixture', url: open.base + '/mcp', confirm: { auth: 'none', tools: { list_things: 'change', make_thing: 'change' } } });
      expect(added.status).toBe(201);
      const id: string = added.body.appId;
      const detail = await account.api('GET', `/v1/apps/${id}`);
      expect(detail.body).toMatchObject({ source: 'custom', category: 'custom' });
      expect(detail.body.capabilities).toEqual(expect.arrayContaining([{ name: 'list_things', title: 'list_things', kind: 'change' }, { name: 'make_thing', title: 'make_thing', kind: 'change' }]));
    });
  });

  describe('a Composio app: the login is held by Composio', () => {
    let composio: { server: Server; base: string };
    let tools: Tool[] = [];
    const sessions = new Map<string, { user: string; toolkit: string; connected: boolean }>();
    const seen: Array<{ path: string; key: string | undefined; body: unknown }> = [];

    beforeAll(async () => {
      tools = [READ, WRITE];
      const port = Number(new URL(stackUrls().composioUrl).port);
      const mcp = mcpHandler(() => tools, (request) => request.headers['x-composio-session'] === 'secret-for-' + (request.url ?? '').split('/').pop());
      composio = await listen(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname.startsWith('/mcp/')) return mcp(request, response);
        // The test's stand-in for the person finishing the login at Composio.
        if (url.pathname.startsWith('/_login/')) {
          const session = sessions.get(url.pathname.split('/').pop() ?? '');
          if (session !== undefined) session.connected = true;
          return json(response, { ok: session !== undefined });
        }
        if (request.headers['x-api-key'] !== stackUrls().composioKey) return json(response, { error: 'bad key' }, 401);
        const body = request.method === 'POST' ? JSON.parse(await readBody(request)) as Record<string, unknown> : undefined;
        seen.push({ path: url.pathname, key: request.headers['x-api-key'] as string | undefined, body });
        const base = '/api/v3.1/tool_router/session';
        if (request.method === 'POST' && url.pathname === base) {
          const id = 'sess-' + String(sessions.size + 1);
          sessions.set(id, { user: String(body?.['user_id']), toolkit: ((body?.['toolkits'] as { enable: string[] }).enable[0]) ?? '', connected: false });
          return json(response, { session_id: id, mcp: { url: composio.base + '/mcp/' + id, headers: { 'x-composio-session': 'secret-for-' + id } } });
        }
        const match = /^\/api\/v3\.1\/tool_router\/session\/([^/]+)\/(toolkits|link)$/.exec(url.pathname);
        const session = match === null ? undefined : sessions.get(match[1] ?? '');
        if (session === undefined || match === null) return json(response, { error: 'no session' }, 404);
        if (match[2] === 'toolkits') return json(response, { items: session.connected ? [{ slug: session.toolkit, connection: { is_active: true } }] : [], next_cursor: null });
        return json(response, { redirect_url: composio.base + '/login/' + (match[1] ?? '') + '?cb=' + encodeURIComponent(String((body as { callback_url: string }).callback_url)) });
      }, port);
    });
    afterAll(async () => { await close(composio.server); });

    it('connects through Composio, keeps the key off the page, holds a tool that changes afterwards, and a first-party app hides its Composio twin', async () => {
      const account = await createAccount('layers-composio');
      const appNamed = async (id: string) => ((await account.api('GET', '/v1/apps')).body.items as Array<{ id: string; source: string; available: boolean; installations: Array<{ id: string; status: string }> }>).find((app) => app.id === id);
      expect(await appNamed('spotify')).toMatchObject({ source: 'composio', available: true, installations: [] });
      // Salesforce is an official app whose sign-in needs our client (not configured here); it lists as unavailable, not as a Composio app.
      expect(await appNamed('salesforce')).toMatchObject({ source: 'official', available: false });

      const started = await account.api('POST', '/v1/apps/spotify/install', {});
      expect(started.status).toBe(201);
      const login = new URL(started.body.openUrl as string);
      expect(login.origin).toBe(composio.base);
      expect(seen.find((call) => call.path === '/api/v3.1/tool_router/session')?.body).toMatchObject({ user_id: account.userId, toolkits: { enable: ['spotify'] }, auth_configs: { spotify: 'ac_e2e_spotify' } });

      // The person logs in at Composio; the browser comes back to our callback, which asks Composio and flips the connection.
      const sessionId = login.pathname.split('/').pop() ?? '';
      await fetch(composio.base + '/_login/' + sessionId);
      const back = await fetch(login.searchParams.get('cb') ?? '', { redirect: 'manual' });
      expect(back.status).toBe(302);
      expect(back.headers.get('location')).toContain('status=connected');
      // A second visit with the same state finds nothing to redeem.
      expect((await fetch(login.searchParams.get('cb') ?? '', { redirect: 'manual' })).status).toBe(400);
      expect(await appNamed('spotify')).toMatchObject({ installations: [{ status: 'connected' }] });

      // Tools: the unmarked one is a change; Composio's header never reaches the page.
      const first = await account.api('GET', '/v1/apps/spotify');
      expect(JSON.stringify(first.body)).not.toContain('secret-for-');
      expect(first.body.capabilities).toEqual(expect.arrayContaining([{ name: 'list_things', title: 'list_things', kind: 'read' }, { name: 'make_thing', title: 'make_thing', kind: 'change' }]));

      // The server adds a tool and changes a parameter of an existing one: both are held for review, as changes.
      tools = [{ ...READ, inputSchema: { type: 'object', properties: { everything: { type: 'boolean' } } } }, WRITE, { name: 'export_all', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];
      const drifted = await account.api('GET', '/v1/apps/spotify');
      expect(drifted.body.capabilities).toEqual(expect.arrayContaining([
        { name: 'list_things', title: 'list_things', kind: 'change', needsReview: true },
        { name: 'export_all', title: 'export_all', kind: 'change', needsReview: true },
        { name: 'make_thing', title: 'make_thing', kind: 'change' },
      ]));
      expect((await account.api('POST', '/v1/apps/spotify/tools/review', {})).body).toMatchObject({ reviewed: expect.arrayContaining(['list_things', 'export_all']) });
      expect((await account.api('GET', '/v1/apps/spotify')).body.capabilities).toEqual(expect.arrayContaining([{ name: 'list_things', title: 'list_things', kind: 'read' }]));
    });
  });
});
