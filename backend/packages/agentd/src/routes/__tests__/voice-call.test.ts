import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import type { WakeEvent } from '@agent-desktop/contracts';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

describe('voice call issuance', () => {
  it('authorizes the conversation and passes server-owned identity to the issuer', async () => {
    const store = createMemoryStore();
    const seed = withDefaultOwner(store, 'alice');
    await seed.put('agents', { id: 'agent', name: 'Agent', status: 'idle', createdBy: 'alice', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as Agent);
    await seed.put('conversations', {
      id: 'direct', kind: 'direct', agentIds: ['agent'], memberIds: ['alice'], unreadCount: 0,
      createdAt: new Date().toISOString(), lastItemAt: new Date().toISOString(),
    } as Conversation);
    await seed.put('conversations', {
      id: 'room', kind: 'room', agentIds: ['agent'], memberIds: ['alice'], unreadCount: 0,
      createdAt: new Date().toISOString(), lastItemAt: new Date().toISOString(),
    } as Conversation);
    await seed.put('conversations', {
      id: 'channel', kind: 'direct', agentIds: ['agent'], memberIds: ['alice'], unreadCount: 0,
      channel: { kind: 'telegram', channelId: 'external' },
      createdAt: new Date().toISOString(), lastItemAt: new Date().toISOString(),
    } as Conversation);
    const issue = vi.fn().mockResolvedValue({ url: 'wss://example.test', token: 'token', participantIdentity: 'user' });
    const app = createTestApp({ store, bus: store.eventBus, enqueuer: new NoopEnqueuer(), voiceCallIssuer: { issue } });
    const path = '/v1/conversations/direct/voice-calls';
    expect((await app.request(path, { method: 'POST' })).status).toBe(401);
    expect((await requestAs(app, 'bob', path, { method: 'POST' })).status).toBe(404);
    expect((await requestAs(app, 'alice', '/v1/conversations/room/voice-calls', { method: 'POST' })).status).toBe(400);
    expect((await requestAs(app, 'alice', '/v1/conversations/channel/voice-calls', { method: 'POST' })).status).toBe(400);
    expect(issue).not.toHaveBeenCalled();
    const response = await requestAs(app, 'alice', path, { method: 'POST' });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(issue).toHaveBeenCalledWith('alice', 'direct', 'agent');
    issue.mockRejectedValueOnce(new Error('private provider detail'));
    const failure = await requestAs(app, 'alice', path, { method: 'POST' });
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('private provider detail');
  });
});

async function seedDirect(owner = 'alice') {
  const store = createMemoryStore();
  const seed = withDefaultOwner(store, owner);
  const now = new Date().toISOString();
  await seed.put('agents', { id: 'agent', name: 'Agent', status: 'idle', createdBy: owner, createdAt: now, updatedAt: now } as unknown as Agent);
  await seed.put('conversations', { id: 'direct', kind: 'direct', agentIds: ['agent'], memberIds: [owner], unreadCount: 0, createdAt: now, lastItemAt: now } as Conversation);
  return store;
}

class WakeRecorder extends NoopEnqueuer {
  wakes: WakeEvent[] = [];
  override async enqueue(event?: unknown): Promise<{ accepted: boolean; runId: string }> {
    this.wakes.push(event as WakeEvent);
    return { accepted: true, runId: 'run-1' };
  }
}

const runBody = (id: string, extra: Record<string, unknown> = {}) => ({ threadId: 'direct', runId: 'run-1', state: {}, messages: [{ id, role: 'user', content: 'hello' }], tools: [], context: [], ...extra });

describe('the voice channel of a run', () => {
  it('is set by the voice entrance (explicit field on the wake), and never by a voice- id or a public body', async () => {
    const store = await seedDirect();
    const enqueuer = new WakeRecorder();
    const app = createTestApp({ store, bus: store.eventBus, enqueuer });
    expect((await requestAs(app, 'alice', '/v1/conversations/direct/voice/runs', { method: 'POST', body: runBody('voice-1') })).status).toBe(202);
    // The public run route: a voice- id is just an id, and a channel smuggled into the body is ignored.
    expect((await requestAs(app, 'alice', '/v1/conversations/direct/runs', { method: 'POST', body: runBody('voice-2', { forwardedProps: { juno: { channel: 'voice' } }, state: { channel: 'voice' } }) })).status).toBe(202);
    expect(enqueuer.wakes.map((wake) => [wake.payload['itemId'], wake.payload['channel']])).toEqual([['voice-1', 'voice'], ['voice-2', undefined]]);
    // Service-authenticated like every internal route.
    expect((await app.request('/v1/conversations/direct/voice/runs', { method: 'POST', body: JSON.stringify(runBody('voice-3')) })).status).toBe(401);
  });
});

describe('POST /v1/conversations/:id/voice/warm', () => {
  it('warms the conversation\'s own session, at most once a minute, and never turns a failure into an error', async () => {
    const store = await seedDirect();
    const warm = vi.fn().mockResolvedValue('warmed');
    const app = createTestApp({ store, bus: store.eventBus, enqueuer: new NoopEnqueuer(), warm });
    const path = '/v1/conversations/direct/voice/warm';
    expect((await app.request(path, { method: 'POST' })).status).toBe(401);
    expect((await requestAs(app, 'bob', path, { method: 'POST' })).status).toBe(404);
    expect(warm).not.toHaveBeenCalled();

    const first = await requestAs(app, 'alice', path, { method: 'POST' });
    expect(await first.json()).toEqual({ status: 'warmed' });
    expect(warm).toHaveBeenCalledWith({ ownerId: 'alice', agentId: 'agent', conversationId: 'direct', sessionKey: 'agent:direct' }, expect.any(AbortSignal));
    expect(await (await requestAs(app, 'alice', path, { method: 'POST' })).json()).toEqual({ status: 'throttled' });
    expect(warm).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      warm.mockRejectedValueOnce(new Error('provider down'));
      const failed = await requestAs(app, 'alice', path, { method: 'POST' });
      expect(failed.status).toBe(200);
      expect(await failed.json()).toEqual({ status: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 503 where no warm-up is wired', async () => {
    const store = await seedDirect();
    const app = createTestApp({ store, bus: store.eventBus, enqueuer: new NoopEnqueuer() });
    expect((await requestAs(app, 'alice', '/v1/conversations/direct/voice/warm', { method: 'POST' })).status).toBe(503);
  });
});

describe('POST /v1/conversations/:id/voice/prepare', () => {
  it('prepares the owner\'s own conversation, throttled per conversation, and never turns a failure into an error', async () => {
    const store = await seedDirect();
    const prepare = vi.fn().mockResolvedValue('prepared');
    const app = createTestApp({ store, bus: store.eventBus, enqueuer: new NoopEnqueuer(), prepare });
    const path = '/v1/conversations/direct/voice/prepare';
    expect((await app.request(path, { method: 'POST' })).status).toBe(401);
    expect((await requestAs(app, 'bob', path, { method: 'POST' })).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();

    expect(await (await requestAs(app, 'alice', path, { method: 'POST' })).json()).toEqual({ status: 'prepared' });
    expect(prepare).toHaveBeenCalledWith({ ownerId: 'alice', agentId: 'agent', conversationId: 'direct', sessionKey: 'agent:direct' }, expect.any(AbortSignal));
    // Start of speech fires often: a second one right after does nothing.
    expect(await (await requestAs(app, 'alice', path, { method: 'POST' })).json()).toEqual({ status: 'throttled' });
    expect(prepare).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 4_000);
      prepare.mockRejectedValueOnce(new Error('registry down'));
      const failed = await requestAs(app, 'alice', path, { method: 'POST' });
      expect(failed.status).toBe(200);
      expect(await failed.json()).toEqual({ status: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 503 where no preparation is wired', async () => {
    const store = await seedDirect();
    const app = createTestApp({ store, bus: store.eventBus, enqueuer: new NoopEnqueuer() });
    expect((await requestAs(app, 'alice', '/v1/conversations/direct/voice/prepare', { method: 'POST' })).status).toBe(503);
  });
});
