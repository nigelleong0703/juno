/**
 * ChatGPT sign-in over HTTP. A forged, replayed or expired callback is a 400 and another owner's login is a
 * 404; the completed provider and every list response carry no token. The token endpoint is the injected
 * fixture (oauthFetch), the same injection point the rest of the app uses for its upstream.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createApiApp, type ApiAuth } from '../server.js';
import type { ModelCatalogLoader } from '../modules/settings.js';
import type { ModelProviderCatalogClient } from '../modules/model-providers.js';

const A = 'owner-a';
const B = 'owner-b';
const ACCESS = 'at-fixture-access-token';
const REFRESH = 'rt-fixture-refresh-token';
const REDIRECT = 'http://127.0.0.1:1455/auth/callback';

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

const providerClient: ModelProviderCatalogClient = {
  async builtinProviders() {
    return [{ id: 'openai', name: 'OpenAI', authKinds: ['api_key'], modelCount: 2 }];
  },
  async providerModels() {
    return { kind: 'ok', catalog: { defaultModel: 'gpt-x', items: [{ id: 'gpt-x', name: 'GPT X', supportsImages: false }] } };
  },
  async effectiveTiers() {
    return null;
  },
  async effectiveSystemOneModel() {
    return null;
  },
};

const noModels: ModelCatalogLoader = async () => ({ defaultModel: 'env', items: [{ id: 'env', name: 'env', supportsImages: false }] });

/** The token endpoint fixture: answers the code exchange with a direct-use grant. */
const tokenEndpoint = (async () => Response.json({
  access_token: ACCESS,
  refresh_token: REFRESH,
  scope: 'openid offline_access chatgpt.tokens.use.direct',
  expires_in: 3600,
  id_token: 'id',
})) as typeof fetch;

function build(store: Store) {
  const app = createApiApp({
    auth: testAuth(),
    agentdUrl: 'http://127.0.0.1:8788',
    internalToken: 'service-token',
    fetch: async () => Response.json({ items: [] }),
    store, blobs: createMemoryBlobStore(),
    modelsLoader: noModels,
    providerClient,
    platformDefault: false,
    oauthFetch: tokenEndpoint,
  });
  return (path: string, session: string, body?: unknown, method = 'POST') => Promise.resolve(app.request(path, {
    method,
    headers: { Authorization: 'Bearer ' + session, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

function ownerView(store: Store, ownerId: string): Store {
  if (store.forOwner === undefined) throw new Error('store must support forOwner');
  return store.forOwner(ownerId);
}

async function start(call: ReturnType<typeof build>, session: string): Promise<{ loginId: string; state: string; authorizationUrl: string }> {
  const response = await call('/v1/model-providers/chatgpt/login', session);
  const body = await response.json() as { authorizationUrl: string; loginId: string };
  const state = new URL(body.authorizationUrl).searchParams.get('state') ?? '';
  return { ...body, state };
}

function callback(state: string): string {
  const url = new URL(REDIRECT);
  url.searchParams.set('code', 'code-1');
  url.searchParams.set('state', state);
  url.searchParams.set('client_id', 'issued-client');
  return url.toString();
}

describe('ChatGPT sign-in over HTTP', () => {
  it('refuses a forged state with 400 and a replayed login with 400', async () => {
    process.env['SECRETS_KEY'] = Buffer.alloc(32, 9).toString('base64');
    const store = createMemoryStore();
    const call = build(store);
    const login = await start(call, 'sess-a');
    const forged = await call('/v1/model-providers/chatgpt/complete', 'sess-a', { loginId: login.loginId, callbackUrl: callback('forged') });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe('STATE_MISMATCH');

    const replay = await call('/v1/model-providers/chatgpt/complete', 'sess-a', { loginId: login.loginId, callbackUrl: callback(login.state) });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('LOGIN_INVALID');
  });

  it('refuses an expired login with 400', async () => {
    process.env['SECRETS_KEY'] = Buffer.alloc(32, 9).toString('base64');
    const store = createMemoryStore();
    const call = build(store);
    const login = await start(call, 'sess-a');
    await ownerView(store, A).patch('modelProviderLogins', login.loginId, { expiresAt: '2000-01-01T00:00:00.000Z' });
    const response = await call('/v1/model-providers/chatgpt/complete', 'sess-a', { loginId: login.loginId, callbackUrl: callback(login.state) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('LOGIN_EXPIRED');
  });

  it('reports status and cancel, and arms the redirect listener only when one is wired', async () => {
    process.env['SECRETS_KEY'] = Buffer.alloc(32, 9).toString('base64');
    const store = createMemoryStore();
    const call = build(store);
    const login = await start(call, 'sess-a');
    expect((await (await call('/v1/model-providers/chatgpt/login', 'sess-a')).json() as { automatic: boolean }).automatic).toBe(false);
    expect(await (await call(`/v1/model-providers/chatgpt/login/${login.loginId}`, 'sess-a', undefined, 'GET')).json()).toEqual({ status: 'pending' });
    expect((await call(`/v1/model-providers/chatgpt/login/${login.loginId}`, 'sess-b', undefined, 'GET')).status).toBe(404);
    expect((await call(`/v1/model-providers/chatgpt/login/${login.loginId}`, 'sess-a', undefined, 'DELETE')).status).toBe(204);
    expect(await (await call(`/v1/model-providers/chatgpt/login/${login.loginId}`, 'sess-a', undefined, 'GET')).json())
      .toMatchObject({ status: 'failed', error: { code: 'CANCELLED' } });
  });

  it('answers another owner\'s login with 404', async () => {
    process.env['SECRETS_KEY'] = Buffer.alloc(32, 9).toString('base64');
    const store = createMemoryStore();
    const call = build(store);
    const login = await start(call, 'sess-a');
    const response = await call('/v1/model-providers/chatgpt/complete', 'sess-b', { loginId: login.loginId, callbackUrl: callback(login.state) });
    expect(response.status).toBe(404);
  });

  it('completes the sign-in, keeps every token out of the responses, and reports the provider connected', async () => {
    process.env['SECRETS_KEY'] = Buffer.alloc(32, 9).toString('base64');
    const store = createMemoryStore();
    const call = build(store);
    const login = await start(call, 'sess-a');
    const done = await call('/v1/model-providers/chatgpt/complete', 'sess-a', { loginId: login.loginId, callbackUrl: callback(login.state) });
    expect(done.status).toBe(200);
    const text = await done.text();
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain(REFRESH);
    const provider = JSON.parse(text) as { auth: string; status: string; accessExpiresAt: string; hasKey: boolean };
    expect(provider).toMatchObject({ auth: 'chatgpt', status: 'connected', hasKey: true });
    expect(Number.isNaN(Date.parse(provider.accessExpiresAt))).toBe(false);

    const listed = await (await call('/v1/model-providers', 'sess-a', undefined, 'GET')).text();
    expect(listed).not.toContain(ACCESS);
    expect(listed).not.toContain(REFRESH);
    expect(listed).toContain('"status":"connected"');
    // Sealed at rest: the stored row never holds the plaintext token.
    const rows = await ownerView(store, A).list('modelProviders', { limit: 10 });
    const row = rows.items.find((item) => item.auth === 'chatgpt');
    expect(row?.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(row?.apiKey).not.toContain(ACCESS);
  });
});
