/**
 * Push notifications, offline: JWT shape against a throwaway key, APNs answers (200 / 410 / BadDeviceToken),
 * trigger selection, and the notifier's owner scoping with a stub sender. No socket is opened.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, verify } from 'crypto';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { EventType, type AgentEvent, type Run } from '@agent-desktop/public-contracts';
import { apnsConfigFromEnv, createApnsSender, signProviderToken, type ApnsPayload, type ApnsTransport } from '../apns.js';
import { createPushNotifier, noticeFor } from '../notifier.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN = 'a'.repeat(64);
const PAYLOAD: ApnsPayload = { aps: { alert: { title: 't', body: 'b' }, sound: 'default' } };

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('APNs provider token', () => {
  it('is an ES256 JWT with kid, iss and iat, and a raw 64-byte r||s signature', () => {
    const jwt = signProviderToken({ keyId: 'KEY123', teamId: 'ABCDE12345', key: privateKey, issuedAtSeconds: 1700000000 });
    const [header, claims, signature] = jwt.split('.');
    expect(decodeSegment(header!)).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(decodeSegment(claims!)).toEqual({ iss: 'ABCDE12345', iat: 1700000000 });
    const raw = Buffer.from(signature!, 'base64url');
    expect(raw).toHaveLength(64);
    const input = Buffer.from(header + '.' + claims);
    expect(verify('sha256', input, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
  });

  it('reads config from env, normalizes escaped PEM, and stays null when incomplete', () => {
    expect(apnsConfigFromEnv({})).toBeNull();
    expect(apnsConfigFromEnv({ APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T' })).toBeNull();
    const escaped = PEM.replace(/\n/g, '\\n');
    const config = apnsConfigFromEnv({ APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_KEY: escaped });
    expect(config).toEqual({ keyId: 'K', teamId: 'T', privateKeyPem: PEM, topic: 'io.github.nigelleong0703.juno' });
  });
});

describe('APNs sender', () => {
  function recordingTransport(responses: Array<{ status: number; body?: string }>) {
    const calls: Array<{ host: string; path: string; headers: Record<string, string>; body: string }> = [];
    const transport: ApnsTransport = async (host, path, headers, body) => {
      calls.push({ host, path, headers, body });
      const next = responses.shift() ?? { status: 200 };
      return { status: next.status, body: next.body ?? '' };
    };
    return { calls, transport };
  }

  const config = { keyId: 'K', teamId: 'T', privateKeyPem: PEM, topic: 'io.github.nigelleong0703.juno' };

  it('posts to the host for the device environment and reuses the token until it nears expiry', async () => {
    const { calls, transport } = recordingTransport([{ status: 200 }, { status: 200 }, { status: 200 }]);
    let now = 1_700_000_000_000;
    const sender = createApnsSender({ config, transport, now: () => now });
    await expect(sender.send({ token: TOKEN, environment: 'sandbox' }, PAYLOAD)).resolves.toBe('sent');
    await expect(sender.send({ token: TOKEN, environment: 'production' }, PAYLOAD)).resolves.toBe('sent');
    now += 51 * 60 * 1000;
    await expect(sender.send({ token: TOKEN, environment: 'sandbox' }, PAYLOAD)).resolves.toBe('sent');

    expect(calls.map((c) => c.host)).toEqual(['api.sandbox.push.apple.com', 'api.push.apple.com', 'api.sandbox.push.apple.com']);
    expect(calls[0]!.path).toBe('/3/device/' + TOKEN);
    expect(calls[0]!.headers['apns-topic']).toBe('io.github.nigelleong0703.juno');
    expect(calls[0]!.headers['apns-push-type']).toBe('alert');
    expect(calls[0]!.headers['authorization']!.startsWith('bearer ')).toBe(true);
    expect(calls[0]!.headers['authorization']).toBe(calls[1]!.headers['authorization']);
    expect(calls[2]!.headers['authorization']).not.toBe(calls[0]!.headers['authorization']);
    expect(JSON.parse(calls[0]!.body)).toEqual(PAYLOAD);
  });

  it('reports 410 and BadDeviceToken as invalid tokens, other rejections as failed', async () => {
    const { transport } = recordingTransport([
      { status: 410, body: '{"reason":"Unregistered"}' },
      { status: 400, body: '{"reason":"BadDeviceToken"}' },
      { status: 400, body: '{"reason":"PayloadTooLarge"}' },
      { status: 503, body: '' },
    ]);
    const errors: string[] = [];
    const sender = createApnsSender({ config, transport, onError: (message) => errors.push(message) });
    const target = { token: TOKEN, environment: 'sandbox' as const };
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('invalid_token');
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('invalid_token');
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('failed');
    await expect(sender.send(target, PAYLOAD)).resolves.toBe('failed');
    expect(errors).toHaveLength(2);
  });

  it('treats a transport error as a failed send, not a dead token', async () => {
    const sender = createApnsSender({
      config,
      transport: async () => {
        throw new Error('socket reset');
      },
      onError: () => undefined,
    });
    await expect(sender.send({ token: TOKEN, environment: 'production' }, PAYLOAD)).resolves.toBe('failed');
  });

});

describe('notice selection', () => {
  const base = { id: 'req-1', kind: 'approval', status: 'pending', title: 'Send the email', summary: '', agentId: 'agent-1', conversationId: 'conv-1', runId: 'run-1', payload: {}, createdAt: '2026-10-11T00:00:00.000Z' };
  const run: Run = { id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title: 'Triage inbox', status: 'completed', kind: 'chat', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: '2026-10-11T00:00:00.000Z', lastActivityAt: '2026-10-11T00:00:00.000Z' };

  it('notifies for new approval and question requests only', async () => {
    expect(await noticeFor({ type: 'request.created', request: base } as unknown as AgentEvent, 'Mira')).toMatchObject({
      title: 'Mira needs you',
      body: 'Send the email',
      data: { conversationId: 'conv-1', requestId: 'req-1', runId: 'run-1' },
    });
    expect(await noticeFor({ type: 'request.created', request: { ...base, kind: 'question' } } as unknown as AgentEvent)).not.toBeNull();
    expect(await noticeFor({ type: 'request.created', request: { ...base, kind: 'admin' } } as unknown as AgentEvent)).toBeNull();
    const long = await noticeFor({ type: 'request.created', request: { ...base, title: 'x'.repeat(1000) } } as unknown as AgentEvent);
    expect(long?.body.length).toBeLessThanOrEqual(180);
  });

  it('notifies only for top-level chat runs that completed or failed', async () => {
    // The wire event carries only the metadata attribution; the notice reads the durable row.
    const event = (over: Partial<Run>): AgentEvent => ({
      type: EventType.RUN_FINISHED,
      threadId: 'conv-1',
      runId: 'run-1',
      outcome: { type: 'success' },
      metadata: { juno: { runId: 'run-1', conversationId: 'conv-1', agentId: 'agent-1' } },
    });
    const finished = (over: Partial<Run>) => noticeFor(event(over), 'Mira', { ...run, ...over });
    expect(await finished({})).toMatchObject({ title: 'Mira finished', body: 'Triage inbox', data: { conversationId: 'conv-1', runId: 'run-1' } });
    expect(await finished({ status: 'failed' })).toMatchObject({ title: 'Mira could not finish' });
    expect(await finished({ status: 'stopped' })).toBeNull();
    expect(await finished({ status: 'blocked' })).toBeNull();
    expect(await finished({ kind: 'routine' })).toBeNull();
    expect(await finished({ parentRunId: 'run-0' })).toBeNull();
  });
});

describe('push notifier', () => {
  async function seeded(): Promise<Store> {
    const mem = createMemoryStore();
    const owned = (owner: string) => mem.forOwner!(owner);
    await owned('owner-a').put('agents', { id: 'agent-1', name: 'Mira' } as never);
    await owned('owner-a').put('requests', { id: 'req-1', kind: 'approval', status: 'pending', title: 'Send the email', summary: '', agentId: 'agent-1', conversationId: 'conv-1', payload: {}, createdAt: '2026-10-11T00:00:00.000Z' } as never);
    await owned('owner-a').put('devices', { id: 'dev-a', platform: 'ios', token: TOKEN, environment: 'sandbox', bundleId: 'io.github.nigelleong0703.juno', createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' });
    await owned('owner-b').put('devices', { id: 'dev-b', platform: 'ios', token: 'b'.repeat(64), environment: 'production', bundleId: 'io.github.nigelleong0703.juno', createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' });
    return mem;
  }

  const requestEvent = { type: 'request.created', request: { id: 'req-1', kind: 'approval', title: 'Send the email', agentId: 'agent-1', conversationId: 'conv-1', status: 'pending', summary: '', payload: {}, createdAt: '2026-10-11T00:00:00.000Z' } } as unknown as AgentEvent;

  it('sends to the owning account devices only, with deep-link ids in the payload', async () => {
    const store = await seeded();
    const sent: Array<{ token: string; environment: string; payload: ApnsPayload }> = [];
    const notifier = createPushNotifier({
      store,
      ios: {
        send: async (target, payload) => {
          sent.push({ token: target.token, environment: target.environment, payload });
          return 'sent';
        },
      },
    });
    await notifier.handle(requestEvent);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ token: TOKEN, environment: 'sandbox' });
    expect(sent[0]!.payload).toMatchObject({
      // The banner names the agent that raised the request, read in the owner's scope.
      aps: { alert: { title: 'Mira needs you', body: 'Send the email' }, sound: 'default', 'thread-id': 'conv-1' },
      conversationId: 'conv-1',
      requestId: 'req-1',
    });
  });

  it('falls back to a generic name when the agent cannot be read', async () => {
    const store = await seeded();
    await store.forOwner!('owner-a').delete('agents', 'agent-1');
    const titles: string[] = [];
    const notifier = createPushNotifier({ store, ios: { send: async (_target, payload) => { titles.push(payload.aps.alert.title); return 'sent'; } } });
    await notifier.handle(requestEvent);
    expect(titles).toEqual(['Your agent needs you']);
  });

  it('forgets a device APNs reports as dead and keeps the others', async () => {
    const store = await seeded();
    const notifier = createPushNotifier({ store, ios: { send: async () => 'invalid_token' } });
    await notifier.handle(requestEvent);
    expect(await store.forOwner!('owner-a').list('devices')).toMatchObject({ items: [] });
    expect(await store.forOwner!('owner-b').list('devices')).toMatchObject({ items: [expect.objectContaining({ id: 'dev-b' })] });
  });

  it('never throws into the caller when the sender fails', async () => {
    const store = await seeded();
    const notifier = createPushNotifier({
      store,
      ios: {
        send: async () => {
          throw new Error('boom');
        },
      },
    });
    await expect(notifier.handle(requestEvent)).resolves.toBeUndefined();
  });
});

describe('push notifier platform routing', () => {
  const FCM_TOKEN = 'fcm_Token-1:' + 'A'.repeat(120);
  const iso = '2026-10-11T00:00:00.000Z';
  const requestEvent = { type: 'request.created', request: { id: 'req-1', kind: 'approval', title: 'Send the email', agentId: 'agent-1', conversationId: 'conv-1', runId: 'run-1', status: 'pending', summary: '', payload: {}, createdAt: iso } } as unknown as AgentEvent;

  async function seeded(): Promise<Store> {
    const mem = createMemoryStore();
    const owner = mem.forOwner!('owner-a');
    await owner.put('agents', { id: 'agent-1', name: 'Mira' } as never);
    await owner.put('requests', { id: 'req-1', kind: 'approval', status: 'pending', title: 'Send the email', summary: '', agentId: 'agent-1', conversationId: 'conv-1', runId: 'run-1', payload: {}, createdAt: iso } as never);
    await owner.put('devices', { id: 'dev-ios', platform: 'ios', token: TOKEN, environment: 'sandbox', bundleId: 'b', createdAt: iso, updatedAt: iso });
    await owner.put('devices', { id: 'dev-android', platform: 'android', token: FCM_TOKEN, environment: 'production', bundleId: 'b', createdAt: iso, updatedAt: iso });
    return mem;
  }

  it('sends iOS devices through APNs and Android devices through FCM, each with its own payload', async () => {
    const store = await seeded();
    const apns: string[] = [];
    const fcm: Array<{ token: string; payload: unknown }> = [];
    const notifier = createPushNotifier({
      store,
      ios: { send: async (target) => { apns.push(target.token); return 'sent'; } },
      android: { send: async (target, payload) => { fcm.push({ token: target.token, payload }); return 'sent'; } },
    });
    await notifier.handle(requestEvent);
    expect(apns).toEqual([TOKEN]);
    expect(fcm).toEqual([
      { token: FCM_TOKEN, payload: { title: 'Mira needs you', body: 'Send the email', data: { conversationId: 'conv-1', requestId: 'req-1', runId: 'run-1' } } },
    ]);
  });

  it('skips Android devices when FCM is not configured, keeping them and still pushing iOS', async () => {
    const store = await seeded();
    const apns: string[] = [];
    const notifier = createPushNotifier({ store, ios: { send: async (target) => { apns.push(target.token); return 'sent'; } } });
    await notifier.handle(requestEvent);
    expect(apns).toEqual([TOKEN]);
    expect(await store.forOwner!('owner-a').list('devices')).toMatchObject({ items: [expect.anything(), expect.anything()] });
  });

  it('forgets an Android device FCM reports as dead and keeps the iOS one', async () => {
    const store = await seeded();
    const notifier = createPushNotifier({ store, ios: { send: async () => 'sent' }, android: { send: async () => 'invalid_token' } });
    await notifier.handle(requestEvent);
    expect(await store.forOwner!('owner-a').list('devices')).toMatchObject({ items: [expect.objectContaining({ id: 'dev-ios' })] });
  });
});

describe('feed brief push', () => {
  const brief = (postIds: string[], notify = true): AgentEvent => ({ type: 'feed.brief', routineId: 'rtn-1', title: 'Morning brief', postIds, firstPostTitle: 'Your Thursday', notify });

  it('pushes the routine name with the post title or a count, and only when the routine notifies', async () => {
    expect(await noticeFor(brief(['a']))).toMatchObject({ title: 'Morning brief', body: 'Your Thursday', data: { screen: 'feed', routineId: 'rtn-1' } });
    expect((await noticeFor(brief(['a', 'b', 'c'])))?.body).toBe('3 new posts');
    expect(await noticeFor(brief(['a'], false))).toBeNull();
  });

  it('delivers to the owner of the routine only', async () => {
    const mem = createMemoryStore();
    await mem.put('routines', { id: 'rtn-1', ownerId: 'owner-a' } as never);
    await mem.put('devices', { id: 'd1', ownerId: 'owner-a', platform: 'ios', token: TOKEN, environment: 'sandbox', bundleId: 'b' } as never);
    await mem.put('devices', { id: 'd2', ownerId: 'owner-b', platform: 'ios', token: 'b'.repeat(64), environment: 'sandbox', bundleId: 'b' } as never);
    const sent: string[] = [];
    await createPushNotifier({ store: mem, ios: { send: async (device) => { sent.push(device.token); return 'sent'; } } }).handle(brief(['a']));
    expect(sent).toEqual([TOKEN]);
  });
});
