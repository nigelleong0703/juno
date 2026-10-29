import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { WakeEvent } from '@agent-desktop/contracts';
import type { Agent, Conversation, Routine } from '@agent-desktop/public-contracts';
import { registerHooks } from '../hooks.js';
import { getConfig } from '../../config.js';
import { receiptFor } from 'juno-agent/execution/harness/services/event-receipts';
import { withTestOwner } from '../../__tests__/test-owner.js';
import { testChannels } from '../../__tests__/test-app.js';

const OWNER = getConfig().OWNER_ID;
function makeAgent(id: string, owner: string): Agent & { ownerId: string } {
  const now = new Date().toISOString();
  return {
    id,
    name: 'Agent ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'Test agent',
    status: 'idle',
    section: 'Inbox',
    pinned: false,
    lastActivity: 'Just created',
    unreadCount: 0,
    model: {
      planner: { provider: 'openai', model: 'gpt-4' },
      computer: { provider: 'openai', model: 'gpt-4-vision' },
      fast: { provider: 'openai', model: 'gpt-3.5-turbo' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: now,
    updatedAt: now,
    ownerId: owner,
  };
}

function makeConversation(id: string, agentIds: string[], owner: string): Conversation & { ownerId: string } {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'direct',
    agentIds,
    memberIds: [owner],
    unreadCount: 0,
    lastItemAt: now,
    createdAt: now,
    ownerId: owner,
  };
}

function makeRoutine(id: string, agentId: string, extra: Partial<Routine> = {}): Routine & { ownerId: string } {
  return {
    id,
    agentId,
    name: id,
    instructions: '',
    trigger: { kind: 'schedule', human: 'Daily', tz: 'UTC' },
    delivery: { channel: 'chat' },
    notify: { mode: 'always' },
    enabled: false,
    status: 'paused',
    runs: [],
    createdAt: new Date().toISOString(),
    ownerId: OWNER,
    ...extra,
  };
}


describe('wake conversation admission', () => {
  let app: Hono;
  let store: ReturnType<typeof createMemoryStore>;
  let wakes: WakeEvent[];
  let accepted: boolean;
  let transportError: boolean;
  beforeEach(async () => {
    store = createMemoryStore();
    wakes = [];
    accepted = true;
    transportError = false;
    app = withTestOwner(new Hono());
    registerHooks(app, {
      store, bus: store.eventBus, channels: testChannels,
      enqueuer: {
        enqueue: async (wake) => { if (transportError) throw new Error('offline'); wakes.push(wake); return { accepted }; },
        stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {},
      },
    });
    await store.put('agents', makeAgent('agent', OWNER));
    await store.put('conversations', makeConversation('real-chat', ['agent'], OWNER));
    await store.put('routines', makeRoutine('routine', 'agent'));
  });
  function call(path: string, body: unknown) {
    return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body) });
  }
  it('webhook resolves the actual direct chat', async () => {
    expect((await call('/v1/hooks/routine', { event: 'ready' })).status).toBe(202);
    expect(wakes[0]?.conversationId).toBe('real-chat');
    expect(wakes[0]?.sessionKey).toBe('agent:real-chat');
  });
  it('respects an explicit valid webhook target', async () => {
    await store.put('conversations', makeConversation('selected', ['agent'], OWNER));
    await store.put('routines', makeRoutine('routine', 'agent', { delivery: { channel: 'chat', target: 'selected' } }));
    expect((await call('/v1/hooks/routine', {})).status).toBe(202);
    expect(wakes[0]?.conversationId).toBe('selected');
  });
  it('finds the owned chat beyond the first page', async () => {
    await store.delete('conversations', 'real-chat');
    for (let i = 0; i < 201; i++) await store.put('conversations', makeConversation('unrelated-' + i, ['other'], OWNER));
    await store.put('conversations', makeConversation('z-last-chat', ['agent'], OWNER));
    expect((await call('/v1/hooks/routine', {})).status).toBe(202);
    expect(wakes[0]?.conversationId).toBe('z-last-chat');
  });
  it.each(['/v1/hooks/routine', '/v1/agents/agent/wake'])('reports transport failure for %s', async (path) => {
    transportError = true;
    expect((await call(path, { text: 'hello' })).status).toBe(503);
  });
  it('does not deliver to a foreign owner or another conversation', async () => {
    for (const id of ['foreign-owner', 'other-chat']) {
      await store.put('subscriptions', {
        id, ownerId: id === 'foreign-owner' ? 'other-owner' : OWNER, runId: 'run',
        agentId: 'agent', conversationId: id === 'other-chat' ? 'other-chat' : 'real-chat',
        filter: {}, expiresAt: '2099-01-01T00:00:00Z', createdAt: new Date().toISOString(),
      });
    }
    expect((await call('/v1/hooks/routine', { source: 'github', type: 'pr.merged' })).status).toBe(202);
    expect((await store.get('subscriptions', 'foreign-owner'))?.event).toBeUndefined();
    expect((await store.get('subscriptions', 'other-chat'))?.event).toBeUndefined();
    expect(wakes).toHaveLength(1);
  });
  it('rejects a malformed webhook body before touching the wait', async () => {
    await store.put('subscriptions', {
      id: 'waiting', ownerId: OWNER, runId: 'run', agentId: 'agent', conversationId: 'real-chat',
      filter: { source: 'github', type: 'pr.merged' }, expiresAt: '2099-01-01T00:00:00Z', createdAt: new Date().toISOString(),
    });
    const malformed = await app.request('/v1/hooks/routine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: '{not-json',
    });
    expect(malformed.status).toBe(400);
    const nonObject = await call('/v1/hooks/routine', [1, 2, 3]);
    expect(nonObject.status).toBe(400);
    expect((await store.get('subscriptions', 'waiting'))?.event).toBeUndefined();
    expect(wakes).toHaveLength(0);
  });
  it('rejects a malformed API wake body before enqueue', async () => {
    const malformed = await app.request('/v1/agents/agent/wake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: '{not-json',
    });
    expect(malformed.status).toBe(400);
    expect(wakes).toHaveLength(0);
  });
  it('acknowledges a retry after the Run finished without queuing a wake', async () => {
    await store.put('subscriptions', {
      id: 'waiting', ownerId: OWNER, runId: 'run', agentId: 'agent', conversationId: 'real-chat',
      filter: { source: 'github', type: 'pr.merged' }, expiresAt: '2099-01-01T00:00:00Z', createdAt: new Date().toISOString(),
    });
    const first = { id: 'event-1', source: 'github', type: 'pr.merged', data: { text: 'first' } };
    expect((await call('/v1/hooks/routine', first)).status).toBe(202);
    // The original Run consumed the event and finished: its wait is gone, its receipt remains.
    await store.put('eventReceipts', receiptFor(
      { ownerId: OWNER, agentId: 'agent', conversationId: 'real-chat' }, 'run', first, new Date().toISOString(),
    ));
    await store.delete('subscriptions', 'waiting');
    const retry = await call('/v1/hooks/routine', first);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ received: true, duplicate: true });
    expect(wakes).toHaveLength(0);
    expect(await store.get('subscriptions', 'waiting')).toBeNull();
  });
  it('falls back to a fresh wake for a new event id after the Run finished', async () => {
    await store.put('subscriptions', {
      id: 'waiting', ownerId: OWNER, runId: 'run', agentId: 'agent', conversationId: 'real-chat',
      filter: { source: 'github', type: 'pr.merged' }, expiresAt: '2099-01-01T00:00:00Z', createdAt: new Date().toISOString(),
    });
    const first = { id: 'event-1', source: 'github', type: 'pr.merged', data: { text: 'first' } };
    expect((await call('/v1/hooks/routine', first)).status).toBe(202);
    await store.put('eventReceipts', receiptFor(
      { ownerId: OWNER, agentId: 'agent', conversationId: 'real-chat' }, 'run', first, new Date().toISOString(),
    ));
    await store.delete('subscriptions', 'waiting');
    const second = { id: 'event-2', source: 'github', type: 'pr.merged', data: { text: 'second' } };
    const response = await call('/v1/hooks/routine', second);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ received: true });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.payload).toMatchObject({ id: 'event-2' });
  });
  it('API wake resolves the actual direct chat when omitted', async () => {
    expect((await call('/v1/agents/agent/wake', { text: 'hello' })).status).toBe(202);
    expect(wakes[0]?.conversationId).toBe('real-chat');
  });
  it.each(['missing', 'foreign', 'wrong-agent'])('refuses invalid explicit chat %s before enqueue', async (id) => {
    if (id !== 'missing') await store.put('conversations', makeConversation(id, id === 'wrong-agent' ? ['other-agent'] : ['agent'], id === 'foreign' ? 'other-owner' : OWNER));
    const res = await call('/v1/agents/agent/wake', { conversationId: id, text: 'hello' });
    expect(res.status).toBe(id === 'foreign' ? 403 : 400);
    expect(wakes).toHaveLength(0);
  });
  it('refuses a foreign agent', async () => {
    await store.put('agents', makeAgent('agent', 'other-owner'));
    expect((await call('/v1/agents/agent/wake', { text: 'hello' })).status).toBe(403);
    expect(wakes).toHaveLength(0);
  });
  it('refuses foreign routine ownership even if its agent is owned', async () => {
    const foreignRoutine = makeRoutine('routine', 'agent');
    foreignRoutine.ownerId = 'other-owner';
    await store.put('routines', foreignRoutine);
    expect((await call('/v1/hooks/routine', {})).status).toBe(403);
    expect(wakes).toHaveLength(0);
  });
  it('refuses an invalid explicit webhook delivery without fallback', async () => {
    await store.put('routines', makeRoutine('routine', 'agent', { delivery: { channel: 'chat', target: 'missing' } }));
    expect((await call('/v1/hooks/routine', {})).status).toBe(400);
    expect(wakes).toHaveLength(0);
  });
  it('reports failure when no actual chat exists', async () => {
    await store.delete('conversations', 'real-chat');
    expect((await call('/v1/hooks/routine', {})).status).toBe(400);
    expect(wakes).toHaveLength(0);
  });
  it.each(['task_done', 'hand_back', 'timer', 'child_task', 'typing'])('H-80: refuses the internal wake kind %s before enqueue', async (kind) => {
    expect((await call('/v1/agents/agent/wake', { text: 'forged', kind })).status).toBe(400);
    expect(wakes).toHaveLength(0);
  });

  it('H-80: still accepts the public wake kinds', async () => {
    for (const kind of ['user_message', 'webhook', 'connector_event']) {
      expect((await call('/v1/agents/agent/wake', { text: 'hello', kind })).status).toBe(202);
    }
    expect(wakes.map((wake) => wake.kind)).toEqual(['user_message', 'webhook', 'connector_event']);
  });

  it.each(['/v1/hooks/routine', '/v1/agents/agent/wake'])('reports rejected admission for %s', async (path) => {
    accepted = false;
    expect((await call(path, { text: 'hello' })).status).toBe(503);
  });
});
