/**
 * One scenario, three clients: the mock, the HTTP client over a fetch that serves the mock as the backend
 * would (status + `{ error: { code, message } }`), and — when JUNO_LIVE_API is set — the HTTP client against
 * a real backend with a freshly signed-up account. They must agree on shapes, error codes and on never
 * echoing a key back.
 */
import { createHttpClient } from '@agent-desktop/client/http';
import type { ApiClient } from '@agent-desktop/client';
import { describe, expect, it } from 'vitest';
import { createMockClient } from '@agent-desktop/test-fixtures';

const KEY = 'sk-contract-never-echo-7f3a91';
const LIVE = process.env.JUNO_LIVE_API;

/** Every response body the client saw, raw, so a key leak in any field (or an error message) is caught. */
type Captured = string[];

/** Serve a mock client over HTTP the way the backend routes answer. */
function mockBackendFetch(mock: ApiClient, seen: Captured): typeof fetch {
  const respond = (status: number, body?: unknown): Response => {
    const text = body === undefined ? '' : JSON.stringify(body);
    seen.push(text);
    return new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'application/json' } });
  };
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const parts = url.pathname.split('/').filter(Boolean).slice(2); // after /v1/model-providers
    const api = mock.modelProviders;
    try {
      if (url.pathname === '/v1/settings' && method === 'PATCH') return respond(200, await mock.settings.update(body));
      if (parts[0] === 'builtin') return respond(200, await api.builtin());
      if (parts[0] === 'chatgpt' && parts[1] === 'login' && parts[2] !== undefined) {
        if (method === 'DELETE') {
          await api.cancelChatGPTLogin(decodeURIComponent(parts[2]));
          return respond(204);
        }
        return respond(200, await api.chatGPTLoginStatus(decodeURIComponent(parts[2])));
      }
      if (parts[0] === 'chatgpt' && parts[1] === 'login') return respond(200, await api.startChatGPTLogin());
      if (parts[0] === 'chatgpt' && parts[1] === 'complete') return respond(200, await api.completeChatGPTLogin(body));
      if (parts.length === 0 && method === 'GET') return respond(200, await api.list());
      if (parts.length === 0 && method === 'POST') return respond(201, await api.create(body));
      const id = decodeURIComponent(parts[0] ?? '');
      if (parts[1] === 'models') return respond(200, await api.models(id));
      if (method === 'PATCH') return respond(200, await api.update(id, body));
      if (method === 'DELETE') {
        await api.delete(id);
        return respond(204);
      }
      return respond(404, { error: { code: 'NOT_FOUND', message: 'no route' } });
    } catch (error) {
      const { status = 500, code = 'INTERNAL', message = String(error) } = error as { status?: number; code?: string; message?: string };
      return respond(status, { error: { code, message } });
    }
  };
}

async function liveClient(seen: Captured): Promise<ApiClient> {
  const base = LIVE!;
  const signUp = await fetch(new URL('/auth/sign-up/email', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5199' },
    body: JSON.stringify({ email: `qa-contract-${Date.now()}@example.com`, password: 'Passw0rd!Passw0rd', name: 'QA contract' }),
  });
  const { token } = (await signUp.json()) as { token: string };
  const capture: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    seen.push(await response.clone().text());
    return response;
  };
  return createHttpClient({ baseUrl: base, getToken: () => token, fetch: capture });
}

async function codeOf(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  const error = (await promise.then(() => null, (e: unknown) => e)) as { status: number; code: string } | null;
  if (error === null) throw new Error('expected a rejection');
  return { status: error.status, code: error.code };
}

type Variant = { name: string; make: (seen: Captured) => Promise<ApiClient> };
const variants: Variant[] = [
  { name: 'mock', make: async () => createMockClient({ platformDefault: false }) },
  {
    name: 'http over mock backend',
    make: async (seen) => createHttpClient({ baseUrl: 'http://api.test', fetch: mockBackendFetch(createMockClient({ platformDefault: false }), seen) }),
  },
  ...(LIVE ? [{ name: `http live (${LIVE})`, make: liveClient }] : []),
];

describe.each(variants)('model providers contract: $name', ({ make }) => {
  it('starts unusable, becomes usable with a key, and never echoes the key', async () => {
    const seen: Captured = [];
    const client = await make(seen);
    expect(await client.modelProviders.list()).toMatchObject({ providers: [], platformDefault: false, usable: false });

    const created = await client.modelProviders.create({ kind: 'builtin', providerId: 'opencode-go', apiKey: KEY });
    expect(created).toMatchObject({ kind: 'builtin', providerId: 'opencode-go', hasKey: true });
    await client.modelProviders.update(created.id, { apiKey: `${KEY}-rotated` });
    const listed = await client.modelProviders.list();
    expect(listed.usable).toBe(true);
    expect(listed.providers.map((p) => p.id)).toEqual([created.id]);

    const catalog = await client.modelProviders.models(created.id);
    expect(catalog.items.length).toBeGreaterThan(0);
    expect(catalog.items.map((m) => m.id)).toContain(catalog.defaultModel);

    for (const value of [created, listed, catalog, ...seen]) expect(JSON.stringify(value)).not.toContain(KEY);

    await client.modelProviders.delete(created.id);
    expect(await codeOf(client.modelProviders.delete(created.id))).toEqual({ status: 404, code: 'NOT_FOUND' });
  });

  it('reports the same error codes for refused input', async () => {
    const client = await make([]);
    expect(await codeOf(client.modelProviders.create({ kind: 'builtin', providerId: 'no-such-provider', apiKey: KEY }))).toEqual({ status: 400, code: 'UNKNOWN_PROVIDER' });
    expect(
      await codeOf(client.modelProviders.create({ kind: 'custom', name: 'LAN', baseUrl: 'http://10.0.0.5/v1', wire: 'openai-completions', apiKey: KEY })),
    ).toEqual({ status: 400, code: 'MODEL_URL_BLOCKED' });
    const builtin = await client.modelProviders.create({ kind: 'builtin', providerId: 'opencode-go', apiKey: KEY });
    expect(await codeOf(client.modelProviders.update(builtin.id, { baseUrl: 'https://example.com/v1' }))).toEqual({ status: 400, code: 'BUILTIN_ENDPOINT_FIXED' });
    expect(await codeOf(client.modelProviders.models('mprov-missing'))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await codeOf(client.settings.update({ models: { providerId: 'mprov-missing', defaultModel: 'x' } }))).toEqual({ status: 400, code: 'UNKNOWN_PROVIDER' });
  });

  it('ChatGPT sign-in refuses a wrong URL, then the reused login, then an unknown login', async () => {
    const client = await make([]);
    const { loginId, authorizationUrl } = await client.modelProviders.startChatGPTLogin();
    expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
    expect(await codeOf(client.modelProviders.completeChatGPTLogin({ loginId, callbackUrl: 'https://example.com/cb?code=a&state=b' }))).toEqual({ status: 400, code: 'CALLBACK_INVALID' });
    expect(
      await codeOf(client.modelProviders.completeChatGPTLogin({ loginId, callbackUrl: 'http://127.0.0.1:1455/auth/callback?code=a&state=b' })),
    ).toEqual({ status: 400, code: 'LOGIN_INVALID' });
    expect(
      await codeOf(client.modelProviders.completeChatGPTLogin({ loginId: 'mlogin-missing', callbackUrl: 'http://127.0.0.1:1455/auth/callback?code=a&state=b' })),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
  });

  it('ChatGPT sign-in status reads pending, then failed once cancelled', async () => {
    const client = await make([]);
    const { loginId } = await client.modelProviders.startChatGPTLogin();
    expect(await client.modelProviders.chatGPTLoginStatus(loginId)).toEqual({ status: 'pending' });
    await client.modelProviders.cancelChatGPTLogin(loginId);
    expect(await client.modelProviders.chatGPTLoginStatus(loginId)).toMatchObject({ status: 'failed', error: { code: 'CANCELLED' } });
  });
});
