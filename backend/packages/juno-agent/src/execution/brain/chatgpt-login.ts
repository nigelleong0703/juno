// Sign in with a ChatGPT subscription, for an owner's OpenAI provider. This module never listens on the
// OAuth callback port. On the server the owner opens the authorize URL and, when the browser ends on the
// redirect URL (which nothing serves), pastes that full URL back. Only the authorize URL, PKCE and the
// code exchange are implemented here, because pi-ai does not export them (its login starts a local
// callback server). Refresh is pi-ai's own, see chatgpt-credential.ts.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../contracts/index.js';
import { toPublicModelProvider, type ModelProviderRecord } from '../../contracts/model-providers.js';
import { decryptSecret, encryptSecret, readSecretsKey } from '../../contracts/secrets.js';
import type { ChatGPTLoginStatus } from '@agent-desktop/public-contracts';
import { chatGPTBundleSchema, sealChatGPTBundle, type ChatGPTBundle } from './chatgpt-credential.js';

// Constants copied from pi-ai's ChatGPT flow (not exported). The client id is dynamic: OpenAI returns the
// issued one in the callback, and the refresh uses that same id.
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;
/** A started sign-in is valid for ten minutes. */
export const CHATGPT_LOGIN_TTL_MS = 10 * 60 * 1000;

/** A login request the owner can fix (400) or that does not belong to them (404). */
export class ChatGPTLoginError extends Error {
  constructor(
    readonly code: 'LOGIN_INVALID' | 'LOGIN_EXPIRED' | 'STATE_MISMATCH' | 'CALLBACK_INVALID' | 'LOGIN_FAILED' | 'NOT_FOUND' | 'REAUTHORIZE',
    message: string,
    /** OpenAI's OAuth error name, when the token endpoint refused (e.g. invalid_grant). */
    readonly oauthError?: string,
    /** REAUTHORIZE: the follow-up sign-in the owner continues in the browser. */
    readonly next?: { loginId: string; authorizationUrl: string; expiresAt: string },
  ) {
    super(message);
    this.name = 'ChatGPTLoginError';
  }
}

/**
 * OpenAI's `ext_agent_host_id`: stable for this install and owner, distinct between installs ("distinct for each host,
 * reused for the same host"). Derived from the install's SECRETS_KEY, so nothing new is stored.
 */
export function chatGPTHostId(ownerId: string): string {
  const hex = createHmac('sha256', readSecretsKey()).update('chatgpt-host:' + ownerId).digest('hex');
  const variant = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type FetchFn = typeof fetch;

const base64url = (bytes: Buffer): string => bytes.toString('base64url');
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Begin a sign-in: a fresh PKCE verifier and state, the verifier sealed, the state only hashed. */
export async function startChatGPTLogin(input: { store: Store; ownerId: string; now?: number; clientId?: string }): Promise<{ authorizationUrl: string; loginId: string; expiresAt: string }> {
  const now = input.now ?? Date.now();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  const loginId = 'mlogin-' + randomUUID();
  await input.store.put('modelProviderLogins', {
    id: loginId,
    ownerId: input.ownerId,
    verifier: encryptSecret(verifier),
    stateHash: sha256(state),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHATGPT_LOGIN_TTL_MS).toISOString(),
    ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
  });
  // New registration: the dynamic client and the app's name. Reauthorization: the issued client and no name (OpenAI's flow).
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId ?? DYNAMIC_CLIENT_ID,
    ...(input.clientId === undefined ? { agent_name_hint: 'Juno' } : {}),
    ext_agent_host_id: chatGPTHostId(input.ownerId),
    response_type: 'code',
    redirect_uri: CHATGPT_REDIRECT_URI,
    resource: RESOURCE,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    nonce: base64url(randomBytes(16)),
  }).toString();
  return { authorizationUrl: url.toString(), loginId, expiresAt: new Date(now + CHATGPT_LOGIN_TTL_MS).toISOString() };
}

/** Parse the pasted redirect URL: origin and path must be ours, and the error and code checks follow. */
export function readCallbackUrl(raw: string, expectedClientId?: string): { code: string; state: string; clientId: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ChatGPTLoginError('CALLBACK_INVALID', 'Paste the full callback URL from the browser');
  }
  const expected = new URL(CHATGPT_REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new ChatGPTLoginError('CALLBACK_INVALID', 'The pasted URL is not the ChatGPT sign-in callback');
  }
  if (url.searchParams.get('error') !== null) throw new ChatGPTLoginError('LOGIN_FAILED', 'ChatGPT did not complete the sign-in');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const returned = url.searchParams.get('client_id')?.trim();
  if (!code || !state) throw new ChatGPTLoginError('CALLBACK_INVALID', 'The callback URL is missing the code or state');
  // A reauthorization callback may leave the client id out; one that names another client is refused.
  if (expectedClientId !== undefined && returned && returned !== expectedClientId) throw new ChatGPTLoginError('CALLBACK_INVALID', 'The callback is for a different client');
  const clientId = returned || expectedClientId;
  if (!clientId) throw new ChatGPTLoginError('CALLBACK_INVALID', 'The callback URL did not contain an issued client id');
  return { code, state, clientId };
}

/** Exchange the code for tokens with the pending verifier. The token response is checked, not logged. */
export async function exchangeChatGPTCode(input: { code: string; verifier: string; clientId: string; fetchFn: FetchFn; now: number }): Promise<ChatGPTBundle> {
  const response = await input.fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: CHATGPT_REDIRECT_URI,
      resource: RESOURCE,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    // OpenAI's own error name (invalid_grant, invalid_client, ...) is safe to repeat and says why it refused.
    const refusal: unknown = await response.json().catch(() => null);
    const field = (name: string): string | undefined => {
      const value: unknown = typeof refusal === 'object' && refusal !== null ? Reflect.get(refusal, name) : undefined;
      return typeof value === 'string' ? value.replace(/[^\w .,:'()/-]/g, '').slice(0, 200) : undefined;
    };
    // The error name and OpenAI's own description say why; neither carries a token or the code.
    const reason = [field('error'), field('error_description')].filter(Boolean).join(': ');
    throw new ChatGPTLoginError('LOGIN_FAILED', `OpenAI did not accept the sign-in code${reason === '' ? '' : ` (${reason})`}`, field('error'));
  }
  const body: unknown = await response.json().catch(() => null);
  const token = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    scope: z.string().min(1),
    expires_in: z.number().positive(),
  }).safeParse(body);
  if (!token.success) throw new ChatGPTLoginError('LOGIN_FAILED', 'OpenAI returned an unexpected token response');
  const scopes = token.data.scope.trim().split(/\s+/).filter(Boolean);
  if (!scopes.includes(DIRECT_TOKEN_SCOPE)) throw new ChatGPTLoginError('LOGIN_FAILED', 'The ChatGPT grant does not allow direct API use');
  return chatGPTBundleSchema.parse({
    type: 'oauth',
    access: token.data.access_token,
    refresh: token.data.refresh_token,
    expires: input.now + token.data.expires_in * 1000 - EXPIRY_MARGIN_MS,
    clientId: input.clientId,
    scopes,
  });
}


/**
 * Finish a sign-in: the pending login must belong to the owner, be unexpired and unused, and carry the
 * state the callback returned. It is consumed on the first attempt, whatever its outcome. The bundle is
 * then stored on the owner's OpenAI provider (created, or the existing ChatGPT row updated).
 */
export async function completeChatGPTLogin(input: {
  store: Store;
  ownerId: string;
  loginId: string;
  callbackUrl: string;
  fetchFn?: FetchFn;
  now?: number;
}): Promise<ModelProviderRecord> {
  const now = input.now ?? Date.now();
  // The store is owner-scoped, so another owner's id reads as absent (404), like a missing one.
  const pending = await input.store.get('modelProviderLogins', input.loginId);
  if (pending === null || pending.ownerId !== input.ownerId) throw new ChatGPTLoginError('NOT_FOUND', 'Sign-in not found');
  if (pending.consumedAt !== undefined) throw new ChatGPTLoginError('LOGIN_INVALID', 'This sign-in was already used; start again');
  // One-time: mark it used before anything else can fail, so a replay or a guess cannot retry this login.
  await input.store.patch('modelProviderLogins', input.loginId, { consumedAt: new Date(now).toISOString() });
  try {
    if (Date.parse(pending.expiresAt) <= now) throw new ChatGPTLoginError('LOGIN_EXPIRED', 'This sign-in expired; start again');
    const callback = readCallbackUrl(input.callbackUrl, pending.clientId);
    if (sha256(callback.state) !== pending.stateHash) throw new ChatGPTLoginError('STATE_MISMATCH', 'The callback does not belong to this sign-in; start again');
    const verifier = decryptSecret(pending.verifier);
    let bundle: ChatGPTBundle;
    try {
      bundle = await exchangeChatGPTCode({ code: callback.code, verifier, clientId: callback.clientId, fetchFn: input.fetchFn ?? fetch, now });
    } catch (error) {
      // OpenAI's documented recovery for a refused first exchange: discard the code and authorize again with the issued client.
      // The browser then shows OpenAI's own page (e.g. a plan that does not allow agent access) instead of a bare refusal.
      if (!(error instanceof ChatGPTLoginError && error.oauthError === 'invalid_grant' && pending.clientId === undefined)) throw error;
      const next = await startChatGPTLogin({ store: input.store, ownerId: input.ownerId, clientId: callback.clientId, now });
      await input.store.patch('modelProviderLogins', input.loginId, { outcome: { status: 'reauthorize', nextLoginId: next.loginId } });
      throw new ChatGPTLoginError('REAUTHORIZE', 'OpenAI asks you to confirm again in the browser', undefined, next);
    }
    const record = await upsertChatGPTProvider(input.store, input.ownerId, bundle, now);
    await input.store.patch('modelProviderLogins', input.loginId, { outcome: { status: 'connected', providerId: record.id } });
    return record;
  } catch (error) {
    if (error instanceof ChatGPTLoginError && error.code === 'REAUTHORIZE') throw error;
    // The status endpoint reports how it ended; an unexpected error is a server fault the owner is not told the detail of.
    const known = error instanceof ChatGPTLoginError;
    await input.store.patch('modelProviderLogins', input.loginId, {
      outcome: { status: 'failed', code: known ? error.code : 'INTERNAL', message: known ? error.message : 'Something went wrong on our side' },
    }).catch(() => undefined);
    throw error;
  }
}

/** Abandon a pending sign-in (the owner closed the dialog): it can no longer be completed. */
export async function cancelChatGPTLogin(input: { store: Store; ownerId: string; loginId: string; now?: number }): Promise<void> {
  const pending = await input.store.get('modelProviderLogins', input.loginId);
  if (pending === null || pending.ownerId !== input.ownerId) throw new ChatGPTLoginError('NOT_FOUND', 'Sign-in not found');
  // Cancelling the sign-in the client started also cancels the reauthorization it handed over to.
  if (pending.outcome?.status === 'reauthorize') return cancelChatGPTLogin({ ...input, loginId: pending.outcome.nextLoginId });
  if (pending.consumedAt !== undefined) return;
  await input.store.patch('modelProviderLogins', input.loginId, {
    consumedAt: new Date(input.now ?? Date.now()).toISOString(),
    outcome: { status: 'failed', code: 'CANCELLED', message: 'The sign-in was cancelled' },
  });
}

/** Where a sign-in stands, for a client waiting on the browser. */
export async function readChatGPTLoginStatus(input: { store: Store; ownerId: string; loginId: string; now?: number }): Promise<ChatGPTLoginStatus> {
  const now = input.now ?? Date.now();
  const pending = await input.store.get('modelProviderLogins', input.loginId);
  if (pending === null || pending.ownerId !== input.ownerId) throw new ChatGPTLoginError('NOT_FOUND', 'Sign-in not found');
  const outcome = pending.outcome;
  if (outcome?.status === 'connected') {
    const record = await input.store.get('modelProviders', outcome.providerId);
    if (record !== null && record.ownerId === input.ownerId) return { status: 'connected', provider: toPublicModelProvider(record) };
    return { status: 'failed', error: { code: 'LOGIN_FAILED', message: 'The connected provider is gone' } };
  }
  if (outcome?.status === 'failed') return { status: 'failed', error: { code: outcome.code, message: outcome.message } };
  // Handed over to a reauthorization: report that one (the client keeps polling the id it started with).
  if (outcome?.status === 'reauthorize') return readChatGPTLoginStatus({ ...input, loginId: outcome.nextLoginId });
  if (pending.consumedAt === undefined && Date.parse(pending.expiresAt) <= now) {
    return { status: 'failed', error: { code: 'LOGIN_EXPIRED', message: 'This sign-in expired; start again' } };
  }
  return { status: 'pending' };
}

/** Create or refresh the owner's ChatGPT-backed OpenAI provider row. */
async function upsertChatGPTProvider(store: Store, ownerId: string, bundle: ChatGPTBundle, now: number): Promise<ModelProviderRecord> {
  const sealed = sealChatGPTBundle(bundle);
  const timestamp = new Date(now).toISOString();
  const page = await store.list('modelProviders', { limit: 200 });
  const existing = page.items.find((row) => row.ownerId === ownerId && row.auth === 'chatgpt' && row.providerId === 'openai');
  if (existing !== undefined) {
    const updated = await store.patch('modelProviders', existing.id, { ...sealed, status: 'connected', updatedAt: timestamp });
    return updated;
  }
  return store.put('modelProviders', {
    id: 'mprov-' + randomUUID(),
    ownerId,
    kind: 'builtin',
    name: 'OpenAI (ChatGPT subscription)',
    providerId: 'openai',
    auth: 'chatgpt',
    status: 'connected',
    ...sealed,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}
