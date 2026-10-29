/**
 * Loopback OAuth regression (production binding): a desktop-like publicUrl on
 * 127.0.0.1 authorizes and exchanges Microsoft through localhost with the same
 * port, while Google keeps the IP base and a public Microsoft origin is
 * unchanged. Exercises the real startMcpAuthorization/completeMcpAuthorization
 * with a stub fetch, a real scoped memory store with sealed records, real
 * PKCE/state logic, and a successful MCP verify handshake. No provider network.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { MICROSOFT_ISSUER, openOAuth } from '@agent-desktop/contracts/mcp';
import type { StoredMcpConnection } from '@agent-desktop/contracts/mcp';
import {
  completeMcpAuthorization,
  startMcpAuthorization,
} from '../modules/mcp-authorization.js';

const OWNER = 'owner-loopback';
const PORT = 54321;
const LOOPBACK_IP = 'http://127.0.0.1:' + String(PORT);
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const PUBLIC_ORIGIN = 'https://api.example.com';
const RETURN_URL = 'http://web.test/plugins';

interface LoopbackCase {
  slug: string;
  issuer: string;
  publicUrl: string;
  expected: string;
  env: Record<string, string | undefined>;
}

interface Seen {
  tokenRedirectUri: string | null;
}

const CASES: LoopbackCase[] = [
  {
    slug: 'ms-loopback',
    issuer: MICROSOFT_ISSUER,
    publicUrl: LOOPBACK_IP,
    expected: 'http://localhost:' + String(PORT) + '/oauth/mcp/callback',
    env: { MICROSOFT_CLIENT_ID: 'ms-id' },
  },
  {
    slug: 'google-loopback',
    issuer: GOOGLE_ISSUER,
    publicUrl: LOOPBACK_IP,
    expected: LOOPBACK_IP + '/oauth/mcp/callback',
    env: { GOOGLE_OAUTH_CLIENT_ID: 'g-id' },
  },
  {
    slug: 'ms-public',
    issuer: MICROSOFT_ISSUER,
    publicUrl: PUBLIC_ORIGIN,
    expected: PUBLIC_ORIGIN + '/oauth/mcp/callback',
    env: { MICROSOFT_CLIENT_ID: 'ms-id' },
  },
];

/** Shared stub per case: 401 probe, resource metadata, Google AS metadata, token endpoint, successful MCP verify. */
function makeFetch(mcpUrl: string, prmUrl: string, issuer: string, seen: Seen): typeof fetch {
  const tokenEndpoint = issuer === MICROSOFT_ISSUER ? MS_TOKEN : GOOGLE_TOKEN;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === mcpUrl) {
      if (new Headers(init?.headers).get('authorization')?.startsWith('Bearer ') === true) {
        const raw = typeof init?.body === 'string' ? init.body : '';
        let id: unknown;
        try {
          const parsed: unknown = JSON.parse(raw);
          id = typeof parsed === 'object' && parsed !== null && 'id' in parsed ? parsed.id : undefined;
        } catch {
          return new Response(null, { status: 400 });
        }
        if (id === undefined) return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'fixture', version: '1.0.0' },
          },
        });
      }
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="' + prmUrl + '"' },
      });
    }
    if (url === prmUrl) {
      return Response.json({ resource: mcpUrl, authorization_servers: [issuer] });
    }
    if (issuer === GOOGLE_ISSUER && url.startsWith('https://accounts.google.com/')) {
      return Response.json({
        issuer,
        authorization_endpoint: GOOGLE_AUTH,
        token_endpoint: GOOGLE_TOKEN,
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === tokenEndpoint) {
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      seen.tokenRedirectUri = form.get('redirect_uri');
      return Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    }
    return new Response(null, { status: 404 });
  };
}

async function setupCase(store: Store, c: LoopbackCase, seen: Seen) {
  const mcpUrl = 'https://mcp.test/' + c.slug + '/mcp';
  const prmUrl = 'https://mcp.test/prm/' + c.slug;
  const scoped = store.forOwner?.(OWNER);
  if (scoped === undefined) throw new Error('memory store is missing forOwner');
  const doc: StoredMcpConnection = {
    id: 'con-' + c.slug,
    kind: 'mcp',
    name: c.slug,
    status: 'disconnected',
    endpoint: mcpUrl,
    transport: 'http',
    ownerId: OWNER,
  };
  await scoped.put('connections', doc);
  const deps = {
    store,
    publicUrl: c.publicUrl,
    returnUrl: RETURN_URL,
    env: c.env,
    fetchImpl: makeFetch(mcpUrl, prmUrl, c.issuer, seen),
  };
  return { deps, connectionId: doc.id };
}

describe('mcp loopback redirect regression (production start/complete)', () => {
  const previousKey = process.env.SECRETS_KEY;
  let store: Store;
  beforeAll(() => {
    process.env.SECRETS_KEY = randomBytes(32).toString('base64');
    store = createMemoryStore();
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = previousKey;
  });

  for (const c of CASES) {
    it(c.slug + ' binds authorize and exchange to ' + c.expected, async () => {
      const seen: Seen = { tokenRedirectUri: null };
      const setup = await setupCase(store, c, seen);
      const started = await startMcpAuthorization(setup.deps, OWNER, setup.connectionId);
      if (started.authorizationUrl === null) throw new Error('expected an authorization URL');
      const authorizeUrl = new URL(started.authorizationUrl);
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(c.expected);
      const state = authorizeUrl.searchParams.get('state');
      if (state === null) throw new Error('expected an authorization state');
      const pendingRow = await setup.deps.store.get('connections', setup.connectionId);
      if (pendingRow === null) throw new Error('expected a connection row');
      expect(openOAuth(Reflect.get(pendingRow, 'auth'))?.pending?.redirectUri).toBe(c.expected);
      const outcome = await completeMcpAuthorization(setup.deps, { state, code: 'code-' + c.slug });
      expect(outcome.status).toBe('connected');
      expect(seen.tokenRedirectUri).toBe(c.expected);
      const storedRow = await setup.deps.store.get('connections', setup.connectionId);
      if (storedRow === null) throw new Error('expected a stored connection');
      expect(openOAuth(Reflect.get(storedRow, 'auth'))?.redirectUri).toBe(c.expected);
    });
  }
});
