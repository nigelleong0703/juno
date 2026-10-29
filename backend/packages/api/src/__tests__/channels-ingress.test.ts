/**
 * CH1 channel ingress: POST /v1/channels/:kind/:channelId/events is public, verifies the platform
 * secret itself, and forwards to agentd as the channel's owner. Unknown channel, missing secret and
 * wrong secret all answer one identical 401.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import { createApiApp } from '../server.js';
import type { ApiAuth } from '../server.js';

const UPSTREAM = 'http://127.0.0.1:8788';
const SERVICE_TOKEN = 'service-token';
const SECRET = 'platform-secret-1';

function noSessionAuth(): ApiAuth {
  return {
    info: { mode: 'account', providers: ['credential'] },
    handle: async () => new Response('auth', { status: 200 }),
    resolve: async () => null,
  };
}

interface SeenUpstream {
  url: string;
  headers: Headers;
  body: string;
}

async function build() {
  const seen: SeenUpstream[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rawBody = init?.body;
    seen.push({
      url,
      headers: new Headers(init?.headers),
      body: typeof rawBody === 'string' ? rawBody : rawBody instanceof ArrayBuffer ? Buffer.from(rawBody).toString('utf8') : '',
    });
    return Response.json({ received: true }, { status: 202 });
  };
  const store = createMemoryStore();
  const app = createApiApp({
    auth: noSessionAuth(),
    agentdUrl: UPSTREAM,
    internalToken: SERVICE_TOKEN,
    fetch: fetchFn,
    store,
    blobs: createMemoryBlobStore(),
  });
  const now = new Date().toISOString();
  await store.put('channels', {
    id: 'telegram:bot-1',
    ownerId: 'owner-1',
    agentId: 'agent-1',
    kind: 'telegram',
    channelId: 'bot-1',
    secretHashHex: createHash('sha256').update(SECRET).digest('hex'),
    createdAt: now,
    updatedAt: now,
  });
  return { app, seen, store };
}

function postEvent(app: ReturnType<typeof createApiApp>, headers: Record<string, string>, body: unknown): Promise<Response> {
  return Promise.resolve(app.request('/v1/channels/telegram/bot-1/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
}

const EVENT = { chatType: 'private', threadId: 't1', text: 'hello', externalMessageId: 'm1' };

describe('channel ingress', () => {
  it('forwards a verified secret without a session, as the channel owner', async () => {
    const { app, seen } = await build();
    const res = await postEvent(app, { 'x-channel-secret': SECRET }, EVENT);
    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1);
    const upstream = seen[0];
    if (!upstream) throw new Error('expected one upstream request');
    expect(upstream.url).toBe(UPSTREAM + '/v1/channels/telegram/bot-1/events');
    expect(upstream.headers.get('authorization')).toBe('Bearer ' + SERVICE_TOKEN);
    expect(upstream.headers.get('x-owner-id')).toBe('owner-1');
  });

  it('accepts the bearer and query secret shapes too', async () => {
    const { app, seen } = await build();
    expect((await postEvent(app, { authorization: 'Bearer ' + SECRET }, EVENT)).status).toBe(202);
    const queried = await app.request('/v1/channels/telegram/bot-1/events?key=' + SECRET, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(EVENT),
    });
    expect(queried.status).toBe(202);
    expect(seen).toHaveLength(2);
  });

  it("accepts Telegram's secret-token header", async () => {
    const { app, seen } = await build();
    expect((await postEvent(app, { 'x-telegram-bot-api-secret-token': SECRET }, EVENT)).status).toBe(202);
    expect(seen).toHaveLength(1);
  });

  it('answers one identical 401 for unknown channel, missing secret and wrong secret', async () => {
    const { app, seen } = await build();
    const unknown = await app.request('/v1/channels/telegram/nope/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-channel-secret': SECRET },
      body: JSON.stringify(EVENT),
    });
    const missing = await postEvent(app, {}, EVENT);
    const wrong = await postEvent(app, { 'x-channel-secret': 'wrong-secret' }, EVENT);
    expect(unknown.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    const [unknownBody, missingBody, wrongBody] = await Promise.all([unknown.text(), missing.text(), wrong.text()]);
    expect(missingBody).toBe(unknownBody);
    expect(wrongBody).toBe(unknownBody);
    expect(seen).toHaveLength(0);
  });

  it('is the only public channel route: other methods stay behind the session', async () => {
    const { app } = await build();
    const res = await app.request('/v1/channels/telegram/bot-1/events', { method: 'GET' });
    expect(res.status).toBe(401);
  });
});

describe('slack install redirect (CH7)', () => {
  it('forwards a known pending state as its owner with the query, and 404s anything else', async () => {
    const { app, seen, store } = await build();
    const now = new Date().toISOString();
    await store.put('channels', {
      id: 'pending:st-1', ownerId: 'owner-1', agentId: 'agent-1', kind: 'pending', channelId: 'st-1', secretHashHex: 'x',
      pending: { platform: 'slack', state: 'pending', expiresAt: now }, createdAt: now, updatedAt: now,
    });
    expect((await app.request('/v1/channels/slack/oauth/callback?code=c&state=nope')).status).toBe(404);
    expect((await app.request('/v1/channels/slack/oauth/callback?code=c')).status).toBe(404);
    expect(seen).toHaveLength(0);
    const ok = await app.request('/v1/channels/slack/oauth/callback?code=c&state=st-1');
    expect(ok.status).toBe(202);
    expect(seen[0]?.url).toBe(UPSTREAM + '/v1/channels/slack/oauth/callback?code=c&state=st-1');
    expect(seen[0]?.headers.get('x-owner-id')).toBe('owner-1');
  });
});

describe('shared Juno Slack app ingress', () => {
  const SHARED = 'shared-signing-secret';

  beforeEach(() => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 5).toString('base64'));
    vi.stubEnv('SLACK_SIGNING_SECRET', SHARED);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function sharedApp() {
    const seen: Array<{ url: string; owner: string | null; body: string }> = [];
    const store = createMemoryStore();
    const app = createApiApp({
      auth: noSessionAuth(),
      agentdUrl: UPSTREAM,
      internalToken: SERVICE_TOKEN,
      fetch: async (input, init) => {
        const body = init?.body;
        seen.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, owner: new Headers(init?.headers).get('x-owner-id'), body: body instanceof ArrayBuffer ? Buffer.from(body).toString('utf8') : '' });
        return Response.json({ received: true }, { status: 202 });
      },
      store,
      blobs: createMemoryBlobStore(),
    });
    const now = new Date().toISOString();
    await store.put('channelInstallations', { id: 'slack:T1', ownerId: 'owner-1', kind: 'slack', teamId: 'T1', botToken: 'x', botUserId: 'UBOT', createdAt: now, updatedAt: now });
    await store.put('channelInstallations', { id: 'slack:T2', ownerId: 'owner-2', kind: 'slack', teamId: 'T2', botToken: 'x', botUserId: 'UBOT', createdAt: now, updatedAt: now });
    return { app, seen };
  }

  function signed(body: string, secret = SHARED, contentType = 'application/json'): Record<string, string> {
    const ts = String(Math.floor(Date.now() / 1000));
    return { 'content-type': contentType, 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=' + createHmac('sha256', secret).update('v0:' + ts + ':' + body).digest('hex') };
  }

  const post = (app: ReturnType<typeof createApiApp>, path: string, headers: Record<string, string>, body: string) =>
    Promise.resolve(app.request(path, { method: 'POST', headers, body }));

  it('verifies the shared signature and forwards each workspace as its own installation owner', async () => {
    const { app, seen } = await sharedApp();
    for (const [team, owner] of [['T1', 'owner-1'], ['T2', 'owner-2']] as const) {
      const body = JSON.stringify({ type: 'event_callback', team_id: team, event: { type: 'message' } });
      expect((await post(app, '/v1/channels/slack/events', signed(body), body)).status).toBe(202);
      expect(seen.at(-1)).toMatchObject({ url: UPSTREAM + '/v1/channels/slack/events', owner, body });
    }
  });

  it('refuses a wrong signature, a missing secret, and a workspace nobody installed', async () => {
    const { app, seen } = await sharedApp();
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T1', event: {} });
    expect((await post(app, '/v1/channels/slack/events', signed(body, 'other'), body)).status).toBe(401);
    const unknown = JSON.stringify({ type: 'event_callback', team_id: 'T9', event: {} });
    expect((await post(app, '/v1/channels/slack/events', signed(unknown), unknown)).status).toBe(401);
    vi.stubEnv('SLACK_SIGNING_SECRET', '');
    expect((await post(app, '/v1/channels/slack/events', signed(body), body)).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('answers the url_verification handshake and routes taps by the workspace in the payload', async () => {
    const { app, seen } = await sharedApp();
    const handshake = JSON.stringify({ type: 'url_verification', challenge: 'c-1' });
    const ok = await post(app, '/v1/channels/slack/events', signed(handshake), handshake);
    expect(await ok.json()).toEqual({ challenge: 'c-1' });
    const form = 'payload=' + encodeURIComponent(JSON.stringify({ type: 'block_actions', team: { id: 'T2' }, actions: [] }));
    const tap = await post(app, '/v1/channels/slack/interactions', signed(form, SHARED, 'application/x-www-form-urlencoded'), form);
    expect(tap.status).toBe(202);
    expect(seen.at(-1)).toMatchObject({ owner: 'owner-2', body: form });
  });
});
