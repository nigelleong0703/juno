/**
 * MCP connect e2e on loopback only: a fixture streamable-HTTP MCP server that requires a bearer token,
 * with its own RFC 9728 / RFC 8414 metadata, dynamic client registration and a token endpoint that checks
 * the S256 PKCE verifier and the RFC 8707 resource. Access tokens live one second, so the agent's first
 * tool call must refresh. The flow goes through the API routes (authorize, browser redirect, callback),
 * then an agent tool call goes through the juno-agent MCP tool path to the fixture.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createMcpManager, mcpToolsForAgent, openOAuth, sealOAuth } from '@agent-desktop/contracts/mcp';
import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';

const SESSION_A = 'sess-a';
const SESSION_B = 'sess-b';
const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const AGENT = 'agent-a';
const PUBLIC_URL = 'http://api.test';
const RETURN_URL = 'http://web.test/plugins';
const CALLBACK = PUBLIC_URL + '/oauth/mcp/callback';

interface Fixture {
  base: string;
  stats: { registrations: number; refreshes: number; toolCalls: number; unauthorized: number; tokenRequests: number; secretsSeen: number };
  control: {
    /** When set, the AS metadata claims this issuer instead of its own origin (a hostile server). */
    claimIssuer?: string;
    /** Forget every issued token, as a provider that revoked the grant would. */
    revokeAll(): void;
  };
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Starts the fixture on 127.0.0.1 with an ephemeral port; the callback URL is the only redirect it allows. */
function startFixture(): Promise<Fixture> {
  const codes = new Map<string, { challenge: string; redirectUri: string; resource: string; used: boolean }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Map<string, number>();
  const clients = new Set<string>();
  const stats = { registrations: 0, refreshes: 0, toolCalls: 0, unauthorized: 0, tokenRequests: 0, secretsSeen: 0 };
  const control: Fixture['control'] = {
    revokeAll: () => {
      accessTokens.clear();
      refreshTokens.clear();
    },
  };
  let base = '';
  let counter = 0;

  function issue(): { access_token: string; token_type: string; expires_in: number; refresh_token: string; scope: string } {
    counter += 1;
    const access = 'at-' + String(counter) + '-' + randomUUID();
    const refresh = 'rt-' + String(counter) + '-' + randomUUID();
    accessTokens.set(access, Date.now() + 1000);
    refreshTokens.add(refresh);
    return { access_token: access, token_type: 'Bearer', expires_in: 1, refresh_token: refresh, scope: 'mcp' };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, { resource: base + '/mcp', authorization_servers: [base] });
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: control.claimIssuer ?? base,
        authorization_endpoint: base + '/authorize',
        token_endpoint: base + '/token',
        registration_endpoint: base + '/register',
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      const registration = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
      if (!registration.redirect_uris?.includes(CALLBACK)) return json(res, 400, { error: 'invalid_redirect_uri' });
      stats.registrations += 1;
      const clientId = 'dyn-client-' + String(stats.registrations);
      clients.add(clientId);
      return json(res, 201, { client_id: clientId });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const p = url.searchParams;
      const valid = clients.has(p.get('client_id') ?? '') && p.get('code_challenge_method') === 'S256'
        && p.get('resource') === base + '/mcp' && p.get('redirect_uri') === CALLBACK && (p.get('code_challenge') ?? '') !== '';
      if (!valid) return json(res, 400, { error: 'invalid_request' });
      const code = randomUUID();
      codes.set(code, { challenge: p.get('code_challenge') ?? '', redirectUri: CALLBACK, resource: base + '/mcp', used: false });
      res.writeHead(302, { location: CALLBACK + '?' + new URLSearchParams({ code, state: p.get('state') ?? '' }).toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      stats.tokenRequests += 1;
      if (form.has('client_secret')) stats.secretsSeen += 1;
      if (form.get('grant_type') === 'refresh_token') {
        const presented = form.get('refresh_token') ?? '';
        if (!refreshTokens.has(presented) || form.get('resource') !== base + '/mcp') return json(res, 400, { error: 'invalid_grant' });
        refreshTokens.delete(presented);
        stats.refreshes += 1;
        return json(res, 200, issue());
      }
      const entry = codes.get(form.get('code') ?? '');
      if (entry === undefined || entry.used) return json(res, 400, { error: 'invalid_grant' });
      const verifier = form.get('code_verifier') ?? '';
      const expected = createHash('sha256').update(verifier).digest('base64url');
      if (expected !== entry.challenge || form.get('redirect_uri') !== entry.redirectUri || form.get('resource') !== entry.resource) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      entry.used = true;
      return json(res, 200, issue());
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      const header = req.headers.authorization ?? '';
      const expiry = accessTokens.get(header.slice('Bearer '.length));
      if (!header.startsWith('Bearer ') || expiry === undefined || Date.now() > expiry) {
        stats.unauthorized += 1;
        res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource/mcp"' });
        return res.end();
      }
      const message = JSON.parse(await readBody(req)) as { id?: string | number; method: string; params?: { name?: string; arguments?: { text?: string } } };
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (message.method === 'initialize') {
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
      }
      if (message.method === 'tools/list') {
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
      }
      if (message.method === 'tools/call') {
        stats.toolCalls += 1;
        return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + String(message.params?.arguments?.text ?? '') }] } });
      }
      return json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      base = 'http://127.0.0.1:' + String(port);
      resolve({
        base,
        stats,
        control,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function testAuth(): ApiAuth {
  const owners: Record<string, string> = { [SESSION_A]: OWNER_A, [SESSION_B]: OWNER_B };
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

describe('MCP connect e2e (loopback fixture, OAuth + PKCE + DCR, agent tool call)', () => {
  let fixture: Fixture;
  let store: Store;
  let app: ReturnType<typeof createApiApp>;

  const previousKey = process.env.SECRETS_KEY;
  const previousPrivateHosts = process.env.MCP_ALLOW_PRIVATE_HOSTS;
  // Read at authorize time, so a test can configure a provider client without rebuilding the app.
  const env: Record<string, string | undefined> = {};
  beforeAll(async () => {
    process.env.SECRETS_KEY = randomBytes(32).toString('base64');
    // The fixture listens on loopback, which the MCP guard refuses unless this test/dev escape hatch is set.
    process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
    fixture = await startFixture();
    store = createMemoryStore();
    const scopedA = store.forOwner?.(OWNER_A);
    if (!scopedA) throw new Error('memory store is missing forOwner');
    await scopedA.put('agents', { id: AGENT, name: 'Agent A', pluginIds: [], ownerId: OWNER_A } as never);
    app = createApiApp({
      auth: testAuth(),
      agentdUrl: 'http://127.0.0.1:1',
      internalToken: 'service-token',
      fetch: async () => Response.json({ items: [] }),
      store, blobs: createMemoryBlobStore(),
      publicUrl: PUBLIC_URL,
      mcpOAuth: { returnUrl: RETURN_URL, env },
    });
  });

  afterAll(async () => {
    await fixture.close();
    if (previousKey === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = previousKey;
    if (previousPrivateHosts === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS;
    else process.env.MCP_ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
  });

  function call(path: string, session: string, method = 'GET', body?: unknown): Promise<Response> {
    return Promise.resolve(app.request(path, {
      method,
      headers: { Authorization: 'Bearer ' + session, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }

  /**
   * Adds a custom MCP server by URL the way the Apps page does: look at it first, then add it with the confirmation of what was seen. The app is
   * named by its connection id, and the server's sign-in starts at once. A probe that is refused is the answer.
   */
  const addServer = async (name: string, session = SESSION_A): Promise<Response> => {
    const url = fixture.base + '/mcp';
    const probed = await call('/v1/apps/custom/probe', session, 'POST', { url });
    if (probed.status !== 200) return probed;
    const { auth } = (await probed.json()) as { auth: 'none' | 'oauth' };
    return call('/v1/apps/custom/install', session, 'POST', { name, url, confirm: { auth, tools: {} } });
  };
  /** Signs in to a server added before (or starts over). */
  const signInAgain = (id: string, session = SESSION_A): Promise<Response> => call('/v1/apps/custom/install', session, 'POST', { connectionId: id });
  const statusOf = async (id: string): Promise<string | undefined> => (await store.get('connections', id))?.status;

  it('connects a remote server end to end and the agent calls its tool', async () => {
    // Adding the server probes it: it answers 401, so discovery + DCR + PKCE produce an authorization URL (and no account yet).
    const created = await addServer('Fixture');
    expect(created.status).toBe(201);
    const startedBody = (await created.json()) as { appId: string; installation: unknown; openUrl: string | null };
    const id = startedBody.appId;
    expect(startedBody.installation).toBeNull();
    expect(await statusOf(id)).toBe('disconnected');
    expect(startedBody.openUrl).not.toBeNull();
    const authorizeUrl = new URL(startedBody.openUrl ?? '');
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(fixture.base + '/authorize');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(authorizeUrl.searchParams.get('resource')).toBe(fixture.base + '/mcp');

    // The browser follows the authorize URL; the fixture redirects to our fixed callback with a code.
    const toProvider = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(toProvider.status).toBe(302);
    const callbackLocation = new URL(toProvider.headers.get('location') ?? '');
    const done = await app.request(callbackLocation.pathname + callbackLocation.search);
    expect(done.status).toBe(302);
    const outcome = new URL(done.headers.get('location') ?? '');
    expect(outcome.origin + outcome.pathname).toBe(RETURN_URL);
    expect(outcome.searchParams.get('connection')).toBe(id);
    expect(outcome.searchParams.get('status')).toBe('connected');

    // The server is signed in, and what was answered so far carries no credential or sealed secret.
    expect(await statusOf(id)).toBe('connected');
    expect((await store.get('connections', id))?.enabled).toBe(true);
    expect(JSON.stringify(startedBody)).not.toMatch(/enc:v1:|at-|rt-/);

    // Tokens are sealed at rest.
    const raw = await store.get('connections', id);
    const sealed = Reflect.get(raw ?? {}, 'auth') as { accessToken?: string; refreshToken?: string };
    expect(sealed.accessToken?.startsWith('enc:v1:')).toBe(true);
    expect(sealed.refreshToken?.startsWith('enc:v1:')).toBe(true);

    // Another owner can neither restart the authorization nor remove the server.
    expect((await signInAgain(id, SESSION_B)).status).toBe(404);
    expect(await statusOf(id)).toBe('connected');

    // The callback refuses a replayed, tampered or missing state.
    expect((await app.request('/oauth/mcp/callback?state=' + encodeURIComponent(callbackLocation.searchParams.get('state') ?? '') + '&code=x')).status).toBe(400);
    expect((await app.request('/oauth/mcp/callback?state=' + id + '.forged&code=x')).status).toBe(400);
    expect((await app.request('/oauth/mcp/callback?code=x')).status).toBe(400);

    // The agent sees the server's tool through the juno-agent MCP path and its call reaches the fixture.
    const scopedA = store.forOwner?.(OWNER_A);
    if (!scopedA) throw new Error('memory store is missing forOwner');
    const tools = await mcpToolsForAgent(createMcpManager(), scopedA, AGENT, new Set());
    const echo = tools.find((tool) => tool.mcp === true && tool.name.includes('echo'));
    expect(echo).toBeDefined();
    const refreshesBefore = fixture.stats.refreshes;
    const result = await echo?.execute({ text: 'hello' }, { ownerId: OWNER_A, agentId: AGENT, store: scopedA } as never);
    expect(result?.isError).not.toBe(true);
    expect(JSON.stringify(result?.content)).toContain('echo:hello');
    expect(fixture.stats.toolCalls).toBe(1);
    // The one-second access token forced a refresh before the call, and the rotated token is stored sealed.
    expect(fixture.stats.refreshes).toBeGreaterThan(refreshesBefore);

    // The provider revokes the grant mid-session: the next call fails visibly and the status flips to error.
    fixture.control.revokeAll();
    const failed = await echo?.execute({ text: 'again' }, { ownerId: OWNER_A, agentId: AGENT, store: scopedA } as never).catch((error: unknown) => error);
    expect(failed instanceof Error || (failed as { isError?: boolean } | undefined)?.isError === true).toBe(true);
    expect(await statusOf(id)).toBe('error');

    // Removing the server drops the stored OAuth record and the agent loses the tool.
    expect((await call('/v1/apps/' + id + '/installations/' + id, SESSION_A, 'DELETE')).status).toBe(204);
    const after = Reflect.get((await store.get('connections', id)) ?? {}, 'auth');
    expect(after).toBeNull();
    const toolsAfter = await mcpToolsForAgent(createMcpManager(), scopedA, AGENT, new Set());
    expect(toolsAfter.some((tool) => tool.name.includes('echo'))).toBe(false);
  });

  it('registers a new client when the callback origin changed', async () => {
    // A callback port that changes between launches; a provider checks redirect_uri against the client
    // it registered, so a client from another origin must not be reused.
    const created = await addServer('Origin');
    expect(created.status).toBe(201);
    const { appId: id } = (await created.json()) as { appId: string };
    const registrations = fixture.stats.registrations;

    const stored = await store.get('connections', id);
    const record = openOAuth(Reflect.get(stored ?? {}, 'auth'));
    if (record === undefined) throw new Error('the authorize call must leave an OAuth record');
    expect(record.redirectUri).toBe(CALLBACK);
    await store.patch('connections', id, { auth: sealOAuth({ ...record, redirectUri: 'http://127.0.0.1:1/oauth/mcp/callback' }) } as never);

    expect((await signInAgain(id)).status).toBe(201);
    expect(fixture.stats.registrations).toBe(registrations + 1);
  });

  it('refuses a loopback MCP URL without the escape hatch, at creation and at authorize (MCP_URL_BLOCKED)', async () => {
    delete process.env.MCP_ALLOW_PRIVATE_HOSTS;
    try {
      const refusedAtCreate = await addServer('Blocked');
      expect(refusedAtCreate.status).toBe(400);
      expect(((await refusedAtCreate.json()) as { error: { code: string } }).error.code).toBe('MCP_URL_BLOCKED');

      // A row created while the hatch was on is refused at sign-in once it is off, and the fixture sees no request.
      process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
      const created = await addServer('Stored');
      const { appId: id } = (await created.json()) as { appId: string };
      delete process.env.MCP_ALLOW_PRIVATE_HOSTS;
      const before = { ...fixture.stats };
      const started = await signInAgain(id);
      expect(started.status).toBe(400);
      expect(((await started.json()) as { error: { code: string } }).error.code).toBe('MCP_URL_BLOCKED');
      expect(fixture.stats).toEqual(before);
    } finally {
      process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
    }
  });

  it('never sends the configured provider secret to an authorization server that claims that issuer', async () => {
    env.GOOGLE_OAUTH_CLIENT_ID = 'configured-client-id';
    env.GOOGLE_OAUTH_CLIENT_SECRET = 'configured-client-secret';
    fixture.control.claimIssuer = 'https://accounts.google.com';
    const tokenRequestsBefore = fixture.stats.tokenRequests;
    try {
      const started = await addServer('Hostile');
      expect(started.status).toBe(502);
      expect(((await started.json()) as { error: { code: string } }).error.code).toBe('MCP_OAUTH_DISCOVERY');
      expect(fixture.stats.tokenRequests).toBe(tokenRequestsBefore);
      expect(fixture.stats.secretsSeen).toBe(0);
    } finally {
      delete env.GOOGLE_OAUTH_CLIENT_ID;
      delete env.GOOGLE_OAUTH_CLIENT_SECRET;
      fixture.control.claimIssuer = undefined;
    }
  });
});
