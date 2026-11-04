import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { isHostedCatalogId } from '../catalog.js';
import { createMcpManager } from '../index.js';
import { sealOAuth } from '../oauth.js';

/**
 * A connection to a server our gateway hosts stores only its path (BACKEND 10.18.5); the URL is built from the public origin
 * (BETTER_AUTH_URL) when it is used, and the hosted-connector credential (HOSTED_MCP_TOKEN) goes with the stored path form alone.
 * A custom server's endpoint is an absolute URL: it never gets the credential, even one pointing at a hosted path on any origin.
 */
const OWNER = 'owner-a';
const auth = { issuer: 'https://accounts.google.com', authorizationEndpoint: 'https://a.example/auth', tokenEndpoint: 'https://a.example/token', resource: '/mcp/google/gmail', clientId: 'c', accessToken: 'ya29.owner', expiresAt: '2999-01-01T00:00:00.000Z' };

describe('the hosted-connector credential', () => {
  const previous = { token: process.env.HOSTED_MCP_TOKEN, url: process.env.BETTER_AUTH_URL, key: process.env.SECRETS_KEY };
  afterEach(() => {
    for (const [name, value] of [['HOSTED_MCP_TOKEN', previous.token], ['BETTER_AUTH_URL', previous.url], ['SECRETS_KEY', previous.key]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('is only for catalog entries whose server we host', () => {
    for (const id of ['gmail', 'google-calendar', 'google-drive', 'google-tasks', 'youtube', 'youtube-account', 'outlook-mail', 'teams']) expect(isHostedCatalogId(id), id).toBe(true);
    for (const id of ['linear', 'notion', 'google-maps', 'google-contacts', 'zapier', undefined, 'custom']) expect(isHostedCatalogId(id), String(id)).toBe(false);
  });

  /** The URL and credential headers the server sees when a stored connection connects under the public origin `origin`. */
  async function seenBy(origin: string, row: Record<string, unknown>): Promise<{ url: string; authorization: string | null; upstream: string | null } | undefined> {
    process.env.HOSTED_MCP_TOKEN = 'svc-secret';
    process.env.BETTER_AUTH_URL = origin;
    process.env.SECRETS_KEY = randomBytes(32).toString('base64');
    let seen: { url: string; authorization: string | null; upstream: string | null } | undefined;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(input), authorization: headers.get('authorization'), upstream: headers.get('x-upstream-authorization') };
      const message = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } } });
      if (message.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
      return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }) as typeof fetch;
    const store = createMemoryStore();
    const scoped = store.forOwner?.(OWNER);
    if (!scoped) throw new Error('test store is missing forOwner');
    await scoped.put('connections', { id: 'con-1', kind: 'mcp', name: 'Mail', status: 'disconnected', enabled: true, ownerId: OWNER, transport: 'http', ...row, auth: sealOAuth(auth) } as never);
    await createMcpManager({ fetchImpl }).connect({ ownerId: OWNER, store: scoped, connectionId: 'con-1' });
    return seen;
  }

  it('a stored hosted connection keeps working when the public origin changes: the URL follows the origin, the credential and the owner token stay', async () => {
    for (const origin of ['http://127.0.0.1:8787', 'https://juno.example.com']) {
      const seen = await seenBy(origin, { endpoint: '/mcp/google/gmail', catalogId: 'gmail' });
      expect(seen, origin).toEqual({ url: origin + '/mcp/google/gmail', authorization: 'Bearer svc-secret', upstream: 'Bearer ya29.owner' });
    }
  });

  it('a custom connection, or a hosted one still stored with an origin, never gets it', async () => {
    for (const row of [
      { endpoint: 'https://gw.example/mcp/google/gmail' },
      { endpoint: 'http://127.0.0.1:8787/mcp/google/gmail' },
      { endpoint: 'https://mcp.third-party.example/mcp' },
      { endpoint: 'https://gw.example/mcp/google/gmail', catalogId: 'gmail' },
    ]) {
      const seen = await seenBy('https://gw.example', row);
      expect(seen?.authorization, row.endpoint).toBe('Bearer ya29.owner');
      expect(seen?.upstream, row.endpoint).toBeNull();
    }
  });
});
