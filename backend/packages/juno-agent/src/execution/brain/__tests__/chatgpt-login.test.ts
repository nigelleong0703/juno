/**
 * ChatGPT subscription sign-in for an owner's OpenAI provider. Security: the state is only hashed and the
 * verifier sealed at rest; a forged, replayed or expired callback is refused and the login is consumed; another
 * owner's login is not found; tokens never appear in the public record. Refresh: concurrent refreshes collapse
 * into one, the rotated bundle is written back, and a refused refresh marks the provider reauth_required and
 * fails the call terminally (no fallback to another key or model).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { decryptSecret } from '../../../contracts/secrets.js';
import { toPublicModelProvider } from '../../../contracts/model-providers.js';
import { ChatGPTLoginError, CHATGPT_LOGIN_TTL_MS, chatGPTHostId, completeChatGPTLogin, readChatGPTLoginStatus, startChatGPTLogin } from '../chatgpt-login.js';
import { chatGPTAccessToken, sealChatGPTBundle, type ChatGPTBundle } from '../chatgpt-credential.js';
import { createUserProvider, type UserProviderBinding } from '../user-providers.js';
import { findBuiltinModel } from '../builtin-providers.js';
import type { ModelSelectionError } from '../model-selection-error.js';
import { ModelSelectionError as ModelSelectionErrorClass } from '../model-selection-error.js';
import { modelWireSchema } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';

const OWNER = 'owner-a';
const OTHER = 'owner-b';
const REDIRECT = 'http://127.0.0.1:1455/auth/callback';
const DIRECT = 'chatgpt.tokens.use.direct';

/** The token endpoint fixture: a successful code exchange answer. */
function tokenFixture(access: string, refresh: string): typeof fetch {
  return (async () => Response.json({
    access_token: access,
    refresh_token: refresh,
    scope: `openid profile offline_access ${DIRECT}`,
    expires_in: 3600,
    id_token: 'id-token',
  })) as typeof fetch;
}

/** The redirect URL the browser ends on, as the owner would paste it. */
function callbackFor(authorizationUrl: string, state?: string): string {
  const url = new URL(authorizationUrl);
  const callback = new URL(REDIRECT);
  callback.searchParams.set('code', 'code-1');
  callback.searchParams.set('state', state ?? url.searchParams.get('state') ?? '');
  callback.searchParams.set('client_id', 'issued-client-id');
  return callback.toString();
}

beforeAll(() => {
  process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
});

afterAll(() => {
  delete process.env['SECRETS_KEY'];
});

/** Owner-scoped store view, as the app uses it; the memory store needs the owner for every write. */
function ownerStore(store: Store, owner: string): Store {
  if (store.forOwner === undefined) throw new Error('forOwner required');
  return store.forOwner(owner);
}

async function startFor(store: Store, owner: string, now?: number) {
  return runWithOwner(owner, () => startChatGPTLogin({ store: ownerStore(store, owner), ownerId: owner, ...(now === undefined ? {} : { now }) }));
}

describe('ChatGPT sign-in: callback checks and storage', () => {
  it('stores only a hashed state and a sealed verifier, and the URL carries the fixed redirect', async () => {
    const store = createMemoryStore();
    const started = await startFor(store, OWNER);
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const row = await ownerStore(store, OWNER).get('modelProviderLogins', started.loginId);
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(url.searchParams.get('state') ?? 'no-state');
    expect(row?.verifier.startsWith('enc:v1:')).toBe(true);
  });

  it('refuses a forged state, and the login is consumed so a retry with the right state also fails', async () => {
    const store = createMemoryStore();
    const started = await startFor(store, OWNER);
    const forged = callbackFor(started.authorizationUrl, 'forged-state');
    await expect(runWithOwner(OWNER, () => completeChatGPTLogin({ store: ownerStore(store, OWNER), ownerId: OWNER, loginId: started.loginId, callbackUrl: forged, fetchFn: tokenFixture('a', 'r') })))
      .rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    await expect(runWithOwner(OWNER, () => completeChatGPTLogin({ store: ownerStore(store, OWNER), ownerId: OWNER, loginId: started.loginId, callbackUrl: callbackFor(started.authorizationUrl), fetchFn: tokenFixture('a', 'r') })))
      .rejects.toMatchObject({ code: 'LOGIN_INVALID' });
  });

  it('refuses an expired login and a callback on another origin', async () => {
    const store = createMemoryStore();
    const started = await startFor(store, OWNER, 0);
    await expect(runWithOwner(OWNER, () => completeChatGPTLogin({
      store: ownerStore(store, OWNER), ownerId: OWNER, loginId: started.loginId,
      callbackUrl: callbackFor(started.authorizationUrl), fetchFn: tokenFixture('a', 'r'), now: CHATGPT_LOGIN_TTL_MS + 1,
    }))).rejects.toMatchObject({ code: 'LOGIN_EXPIRED' });
    const fresh = await startFor(store, OWNER);
    await expect(runWithOwner(OWNER, () => completeChatGPTLogin({
      store: ownerStore(store, OWNER), ownerId: OWNER, loginId: fresh.loginId,
      callbackUrl: 'https://evil.example/auth/callback?code=x&state=y&client_id=z', fetchFn: tokenFixture('a', 'r'),
    }))).rejects.toBeInstanceOf(ChatGPTLoginError);
  });

  it('answers another owner\'s login as not found', async () => {
    const store = createMemoryStore();
    const started = await startFor(store, OWNER);
    await expect(runWithOwner(OTHER, () => completeChatGPTLogin({
      store: ownerStore(store, OTHER), ownerId: OTHER, loginId: started.loginId,
      callbackUrl: callbackFor(started.authorizationUrl), fetchFn: tokenFixture('a', 'r'),
    }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The owner's own login is untouched by the other owner's attempt.
    const row = await ownerStore(store, OWNER).get('modelProviderLogins', started.loginId);
    expect(row?.consumedAt).toBeUndefined();
  });

  it('stores the token bundle sealed on an openai ChatGPT row, absent from the public record', async () => {
    const store = createMemoryStore();
    const started = await startFor(store, OWNER);
    const record = await runWithOwner(OWNER, () => completeChatGPTLogin({
      store: ownerStore(store, OWNER), ownerId: OWNER, loginId: started.loginId,
      callbackUrl: callbackFor(started.authorizationUrl), fetchFn: tokenFixture('at-secret-1', 'rt-secret-1'),
    }));
    expect(record.auth).toBe('chatgpt');
    expect(record.status).toBe('connected');
    expect(record.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(record.apiKey)).toContain('at-secret-1');
    const publicJson = JSON.stringify(toPublicModelProvider(record));
    expect(publicJson).not.toContain('at-secret-1');
    expect(publicJson).not.toContain('rt-secret-1');
    expect(publicJson).toContain('accessExpiresAt');
  });
});

describe('ChatGPT sign-in: OpenAI\'s reauthorization after a refused first exchange', () => {
  const refused = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch;

  it('keeps one host id per install and owner, and reauthorizes with the issued client without the app name', async () => {
    const store = createMemoryStore();
    const first = await startFor(store, OWNER);
    const host = new URL(first.authorizationUrl).searchParams.get('ext_agent_host_id');
    expect(host).toBe(chatGPTHostId(OWNER));
    expect(host).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chatGPTHostId(OTHER)).not.toBe(host);

    const error = await runWithOwner(OWNER, () => completeChatGPTLogin({
      store: ownerStore(store, OWNER), ownerId: OWNER, loginId: first.loginId, callbackUrl: callbackFor(first.authorizationUrl), fetchFn: refused,
    })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatGPTLoginError);
    const next = (error as ChatGPTLoginError).next;
    expect((error as ChatGPTLoginError).code).toBe('REAUTHORIZE');
    const params = new URL(next?.authorizationUrl ?? '').searchParams;
    expect(params.get('client_id')).toBe('issued-client-id');
    expect(params.get('agent_name_hint')).toBeNull();
    expect(params.get('ext_agent_host_id')).toBe(host);
    // The client keeps polling the first id: it follows the hand-over.
    const status = () => runWithOwner(OWNER, () => readChatGPTLoginStatus({ store: ownerStore(store, OWNER), ownerId: OWNER, loginId: first.loginId }));
    expect((await status()).status).toBe('pending');

    // The reauthorization callback may omit the client id; the exchange uses the issued one and connects.
    const callback = new URL(callbackFor(next?.authorizationUrl ?? ''));
    callback.searchParams.delete('client_id');
    await runWithOwner(OWNER, () => completeChatGPTLogin({
      store: ownerStore(store, OWNER), ownerId: OWNER, loginId: next?.loginId ?? '', callbackUrl: callback.toString(), fetchFn: tokenFixture('at-2', 'rt-2'),
    }));
    expect((await status()).status).toBe('connected');
  });

  it('does not loop: a refused reauthorization fails', async () => {
    const store = createMemoryStore();
    const first = await startFor(store, OWNER);
    const error = await runWithOwner(OWNER, () => completeChatGPTLogin({
      store: ownerStore(store, OWNER), ownerId: OWNER, loginId: first.loginId, callbackUrl: callbackFor(first.authorizationUrl), fetchFn: refused,
    }).then(() => undefined, (caught: unknown) => caught as ChatGPTLoginError));
    const next = error?.next;
    const again = await runWithOwner(OWNER, () => completeChatGPTLogin({
      store: ownerStore(store, OWNER), ownerId: OWNER, loginId: next?.loginId ?? '', callbackUrl: callbackFor(next?.authorizationUrl ?? ''), fetchFn: refused,
    }).then(() => undefined, (caught: unknown) => caught as ChatGPTLoginError));
    expect(again?.code).toBe('LOGIN_FAILED');
  });
});

describe('ChatGPT token refresh', () => {
  const expiredBundle: ChatGPTBundle = { type: 'oauth', access: 'at-old', refresh: 'rt-old', expires: Date.now() - 1000, clientId: 'issued-client-id' };

  async function storedRow(store: Store, owner: string, bundle: ChatGPTBundle): Promise<string> {
    const sealed = sealChatGPTBundle(bundle);
    const row = await ownerStore(store, owner).put('modelProviders', {
      id: 'mprov-chatgpt', ownerId: owner, kind: 'builtin', name: 'OpenAI (ChatGPT subscription)', providerId: 'openai',
      auth: 'chatgpt', status: 'connected', ...sealed, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
    });
    return row.id;
  }

  it('collapses concurrent refreshes into one and writes the rotated bundle back', async () => {
    const store = createMemoryStore();
    const id = await storedRow(store, OWNER, expiredBundle);
    let calls = 0;
    const refresh = async (bundle: ChatGPTBundle): Promise<ChatGPTBundle> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...bundle, access: 'at-new', refresh: 'rt-new', expires: Date.now() + 3600_000 };
    };
    await runWithOwner(OWNER, async () => {
      const record = await ownerStore(store, OWNER).get('modelProviders', id);
      if (record === null) throw new Error('row missing');
      const tokens = await Promise.all([1, 2, 3].map(() => chatGPTAccessToken({ store: ownerStore(store, OWNER), ownerId: OWNER, record, refresh })));
      expect(tokens).toEqual(['at-new', 'at-new', 'at-new']);
      expect(calls).toBe(1);
      const after = await ownerStore(store, OWNER).get('modelProviders', id);
      expect(after !== null && decryptSecret(after.apiKey)).toContain('at-new');
    });
  });

  it('a refused refresh marks the provider reauth_required and the call fails terminally, never falling back', async () => {
    const store = createMemoryStore();
    const id = await storedRow(store, OWNER, expiredBundle);
    const refresh = async (): Promise<ChatGPTBundle> => {
      throw new Error('OpenAI OAuth token request failed (400): invalid_grant');
    };
    const model = findBuiltinModel('openai', 'gpt-4o-mini');
    if (model === undefined) throw new Error('catalog model missing');
    const binding: UserProviderBinding = { providerId: id, modelId: 'gpt-4o-mini', baseUrl: model.baseUrl, wire: modelWireSchema.parse(model.api), supportsImages: false };
    await runWithOwner(OWNER, async () => {
      const provider = createUserProvider({ store: ownerStore(store, OWNER), binding, ownerId: () => OWNER, refresh }, {});
      const error = await provider.call({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }], tools: [], signal: AbortSignal.timeout(5000) }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelSelectionErrorClass);
      expect((error as ModelSelectionError).code).toBe('reauth-required');
      expect(((await ownerStore(store, OWNER).get('modelProviders', id))?.status)).toBe('reauth_required');
      // A later call refuses at once, without another refresh attempt.
      let calls = 0;
      const counting = createUserProvider({ store: ownerStore(store, OWNER), binding, ownerId: () => OWNER, refresh: async () => { calls += 1; return expiredBundle; } }, {});
      await expect(counting.call({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }], tools: [], signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({ code: 'reauth-required' });
      expect(calls).toBe(0);
    });
  });
});
