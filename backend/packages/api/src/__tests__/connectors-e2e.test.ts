/**
 * Adding an app on loopback: a catalog entry points at a fixture OAuth MCP server (DCR + PKCE) that offers one read tool
 * (`list_events`, readOnlyHint) and one action tool (`create_event`). Flow: install -> sign in at the provider -> the account is added
 * (a second install adds another account) -> the agent sees both tools (Actions ask first by default) -> Actions Off hides the action
 * tool from the agent and refuses a direct call -> removing the account revokes the grant and removes the tools.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createMcpManager, mcpToolsForAgent } from '@agent-desktop/contracts/mcp';
import { installAppResponseSchema } from '@agent-desktop/public-contracts';
import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';
import type { CatalogEntry } from '../modules/connector-catalog.js';

const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const AGENT = 'agent-a';
const PUBLIC_URL = 'http://api.test';
const CALLBACK = PUBLIC_URL + '/oauth/mcp/callback';

interface Fixture { base: string; stats: { toolCalls: number; revoked: number }; scopes: string[]; close(): Promise<void> }

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function startFixture(): Promise<Fixture> {
  const codes = new Map<string, string>();
  const tokens = new Set<string>();
  const accessOf = new Map<string, string>();
  const stats = { toolCalls: 0, revoked: 0 };
  const scopes: string[] = [];
  let base = '';
  const tools = [
    { name: 'list_events', description: 'List calendar events', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'create_event', description: 'Create a calendar event', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false } },
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, { resource: base + '/mcp', authorization_servers: [base] });
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', code_challenge_methods_supported: ['S256'] });
    }
    if (req.method === 'POST' && url.pathname === '/register') return json(res, 201, { client_id: 'dyn-client' });
    if (req.method === 'GET' && url.pathname === '/authorize') {
      scopes.push(url.searchParams.get('scope') ?? '');
      const code = randomUUID();
      codes.set(code, url.searchParams.get('code_challenge') ?? '');
      res.writeHead(302, { location: CALLBACK + '?' + new URLSearchParams({ code, state: url.searchParams.get('state') ?? '' }).toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      const challenge = codes.get(form.get('code') ?? '');
      if (challenge === undefined || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) return json(res, 400, { error: 'invalid_grant' });
      const access = 'at-' + randomUUID();
      const refresh = 'rt-' + randomUUID();
      tokens.add(access);
      accessOf.set(refresh, access);
      return json(res, 200, { access_token: access, token_type: 'Bearer', refresh_token: refresh });
    }
    if (req.method === 'POST' && url.pathname === '/revoke') {
      // Revokes the one grant the presented token belongs to, as a provider does.
      stats.revoked += 1;
      tokens.delete(accessOf.get(new URLSearchParams(await readBody(req)).get('token') ?? '') ?? '');
      return json(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      const header = req.headers.authorization ?? '';
      if (!tokens.has(header.slice('Bearer '.length))) {
        res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource/mcp"' });
        return res.end();
      }
      const message = JSON.parse(await readBody(req)) as { id?: string | number; method: string };
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      if (message.method === 'initialize') return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
      if (message.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools } });
      if (message.method === 'tools/call') {
        stats.toolCalls += 1;
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } });
      }
      return json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port);
      resolve({ base, stats, scopes, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

function testAuth(): ApiAuth {
  const owners: Record<string, string> = { a: OWNER_A, b: OWNER_B };
  return {
    info: { mode: 'account', providers: ['credential'] },
    handle: async () => new Response('auth', { status: 200 }),
    resolve: async (request) => {
      const header = request.headers.get('authorization');
      const ownerId = header?.startsWith('Bearer ') ? owners[header.slice('Bearer '.length)] : undefined;
      return ownerId ? { ownerId } : null;
    },
  };
}

describe('connector catalog e2e (loopback fixture)', () => {
  let fixture: Fixture;
  let store: Store;
  let app: ReturnType<typeof createApiApp>;
  const previousKey = process.env.SECRETS_KEY;
  const previousPrivateHosts = process.env.MCP_ALLOW_PRIVATE_HOSTS;
  const env: Record<string, string | undefined> = {};
  /** Owners agentd was told to re-check capabilities for (a routine waiting for an app starts, one that lost it goes on hold). */
  const rechecked: string[] = [];

  beforeAll(async () => {
    process.env.SECRETS_KEY = randomBytes(32).toString('base64');
    process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
    fixture = await startFixture();
    store = createMemoryStore();
    await store.forOwner?.(OWNER_A)?.put('agents', { id: AGENT, name: 'Agent A', pluginIds: [], ownerId: OWNER_A } as never);
    const catalog: CatalogEntry[] = [
      { id: 'fake-calendar', name: 'Fake Calendar', icon: 'calendar', description: 'Fixture', category: 'productivity', url: fixture.base + '/mcp', scopes: ['cal.read', 'cal.write'], revocationEndpoint: fixture.base + '/revoke' },
      { id: 'needs-client', name: 'Needs Client', icon: 'x', description: 'Needs a configured client', category: 'files', url: fixture.base + '/mcp', configuredClientIssuer: 'https://accounts.google.com', scopes: ['s'] },
    ];
    app = createApiApp({
      auth: testAuth(), agentdUrl: 'http://127.0.0.1:1', internalToken: 'service-token',
      fetch: async (input, init) => {
        if (String(input) === 'http://127.0.0.1:1/v1/capabilities/recheck') rechecked.push(new Headers(init?.headers).get('x-owner-id') ?? '');
        return Response.json({ items: [] });
      },
      store, blobs: createMemoryBlobStore(), publicUrl: PUBLIC_URL,
      mcpOAuth: { returnUrl: 'http://web.test/connectors', env }, connectorCatalog: catalog,
    });
  });

  afterAll(async () => {
    await fixture.close();
    if (previousKey === undefined) delete process.env.SECRETS_KEY; else process.env.SECRETS_KEY = previousKey;
    if (previousPrivateHosts === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS; else process.env.MCP_ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
  });

  const call = (path: string, session: string, method = 'GET', body?: unknown): Promise<Response> =>
    Promise.resolve(app.request(path, {
      method,
      headers: { Authorization: 'Bearer ' + session, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  const install = (appId: string, session: string, body: unknown = {}): Promise<Response> => call('/v1/apps/' + appId + '/install', session, 'POST', body);
  /** The owner's connection rows of the fixture app: what the Apps page lists as its accounts. */
  const accountsOf = async (owner: string): Promise<Array<{ id: string; status?: string; enabled?: boolean }>> => {
    const scoped = store.forOwner?.(owner);
    if (!scoped) throw new Error('missing forOwner');
    return (await scoped.list('connections')).items.filter((row) => row.catalogId === 'fake-calendar');
  };
  /** Sign in at the fixture provider: follow the authorization URL, then the redirect to the gateway's callback. */
  const signIn = async (authorizationUrl: string | null): Promise<string> => {
    const toProvider = await fetch(authorizationUrl ?? '', { redirect: 'manual' });
    const callback = new URL(toProvider.headers.get('location') ?? '');
    const done = await app.request(callback.pathname + callback.search);
    return new URL(done.headers.get('location') ?? '').searchParams.get('status') ?? '';
  };
  const agentToolNames = async (): Promise<string[]> => {
    const scoped = store.forOwner?.(OWNER_A);
    if (!scoped) throw new Error('missing forOwner');
    return (await mcpToolsForAgent(createMcpManager(), scoped, AGENT, new Set())).map((tool) => tool.name);
  };

  it('install an app, sign in, add a second account, Actions Off hides the action tool, removing an account revokes', async () => {
    // A provider that needs a configured client cannot be added until the deployment has one.
    expect((await install('needs-client', 'a')).status).toBe(400);
    expect(await accountsOf(OWNER_A)).toEqual([]);

    const started = await install('fake-calendar', 'a');
    expect(started.status).toBe(201);
    const { installation, openUrl, appId } = installAppResponseSchema.parse(await started.json());
    expect(appId).toBe('fake-calendar');
    // Not signed in yet: no account to show, a page to open.
    expect(installation).toBeNull();
    expect(openUrl).not.toBeNull();
    const [row] = await accountsOf(OWNER_A);
    const connectionId = row?.id ?? '';
    expect(await signIn(openUrl)).toBe('connected');
    expect(fixture.scopes).toEqual(['cal.read cal.write']);
    // The OAuth callback connected it: agentd is told, for the owner of the connection.
    await vi.waitFor(() => expect(rechecked.at(-1)).toBe(OWNER_A));
    expect(await accountsOf(OWNER_A)).toMatchObject([{ id: connectionId, status: 'connected' }]);
    expect(await accountsOf(OWNER_B)).toEqual([]);

    // Installing again while signed in adds a second account; signing in again to one account (connectionId) does not.
    const second = installAppResponseSchema.parse(await (await install('fake-calendar', 'a')).json());
    expect(await signIn(second.openUrl)).toBe('connected');
    const accounts = await accountsOf(OWNER_A);
    expect(accounts).toHaveLength(2);
    const secondId = accounts.map((account) => account.id).find((id) => id !== connectionId) ?? '';
    const again = await install('fake-calendar', 'a', { connectionId: secondId });
    expect(again.status).toBe(201);
    expect(await accountsOf(OWNER_A)).toHaveLength(2);
    expect((await install('fake-calendar', 'a', { connectionId: 'con-nope' })).status).toBe(404);
    expect((await install('fake-calendar', 'a', { apiKey: 1 })).status).toBe(400);

    // Removing one account leaves the other; another owner cannot remove it (the request is not theirs, so it reaches agentd, which has no such workspace).
    const rechecksBefore = rechecked.length;
    expect((await call('/v1/apps/fake-calendar/installations/' + secondId, 'b', 'DELETE')).status).toBe(200);
    expect(await accountsOf(OWNER_A)).toHaveLength(2);
    expect((await call('/v1/apps/fake-calendar/installations/' + secondId, 'a', 'DELETE')).status).toBe(204);
    const left = await accountsOf(OWNER_A);
    expect(left.find((account) => account.id === connectionId)).toMatchObject({ status: 'connected' });
    expect(left.find((account) => account.id === secondId)).toMatchObject({ enabled: false });
    await vi.waitFor(() => expect(rechecked.length).toBeGreaterThan(rechecksBefore));

    // By default an agent sees both tools (changes ask first); Actions Off hides the action tool and a direct call to it is refused.
    expect(await agentToolNames()).toHaveLength(2);
    const scoped = store.forOwner?.(OWNER_A);
    if (!scoped) throw new Error('missing forOwner');
    await scoped.put('agentApps', { id: AGENT + ':fake-calendar', ownerId: OWNER_A, agentId: AGENT, appId: 'fake-calendar', enabled: true, actionsPolicy: 'off', updatedAt: new Date().toISOString() });
    expect(await agentToolNames()).toHaveLength(1);
    expect((await agentToolNames())[0]).toContain('list_events');
    await expect(createMcpManager().callTool({ ownerId: OWNER_A, store: scoped, agentId: AGENT, connectionId, toolName: 'create_event', args: {} })).rejects.toThrow(/Actions is off/);
    expect(fixture.stats.toolCalls).toBe(0);
    await scoped.put('agentApps', { id: AGENT + ':fake-calendar', ownerId: OWNER_A, agentId: AGENT, appId: 'fake-calendar', enabled: false, actionsPolicy: 'ask', updatedAt: new Date().toISOString() });
    expect(await agentToolNames()).toEqual([]);
    await scoped.put('agentApps', { id: AGENT + ':fake-calendar', ownerId: OWNER_A, agentId: AGENT, appId: 'fake-calendar', enabled: true, actionsPolicy: 'allow', updatedAt: new Date().toISOString() });
    expect(await agentToolNames()).toHaveLength(2);

    // Removing the last account revokes the grant at the provider and takes the tools away.
    expect((await call('/v1/apps/fake-calendar/installations/' + connectionId, 'a', 'DELETE')).status).toBe(204);
    // (The second account had been started over, so it held no grant to revoke when it was removed.)
    expect(fixture.stats.revoked).toBe(1);
    expect(await agentToolNames()).toEqual([]);
  });
});
