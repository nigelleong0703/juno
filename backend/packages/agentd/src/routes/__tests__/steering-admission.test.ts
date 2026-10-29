import { aguiInput } from '../../../../../tests/agui-input.js';
/**
 * GC11 user steering admission over the real HTTP surface.
 *
 * Every authenticated user message admitted by the shared pipeline (room @member / @all mention and
 * direct chat) pins the wake's busy mode to `steer` and targets the current conversation, so a message
 * sent while that conversation's run is busy is consumed by that run rather than queued as a new one.
 * Recipient selection, mention validation and private idle batching are unchanged. Deterministic:
 * memory store + a recording enqueuer, no live model call and no user data change.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Agent } from '@agent-desktop/public-contracts';
import type { Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-08T00:00:00.000Z';

class RecordingEnqueuer implements Enqueuer {
  wakes: WakeEvent[] = [];
  /** Session's decision for a wake; the default accepts it without naming a run. */
  decide: (wake: WakeEvent) => { accepted: boolean; reason?: string; runId?: string } = () => ({ accepted: true });

  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string; runId?: string }> {
    this.wakes.push(event);
    return this.decide(event);
  }

  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

function makeAgent(id: string): Agent {
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
    createdBy: OWNER,
    createdAt: AT,
    updatedAt: AT,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(body: unknown, key: string): string {
  if (!isRecord(body)) throw new Error('expected object body');
  const value = body[key];
  if (typeof value !== 'string') throw new Error('expected string field ' + key);
  return value;
}

describe('user steering admission over HTTP', () => {
  let store: Store;
  let app: Hono;
  let enqueuer: RecordingEnqueuer;

  async function call(path: string, method: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: { ...ownerHeaders(getConfig().OWNER_ID), 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return app.request(path, init);
  }

  async function room(agentIds: string[]): Promise<string> {
    const res = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: agentIds });
    expect(res.status, await res.clone().text()).toBe(201);
    return stringField(await res.json(), 'id');
  }

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, getConfig().OWNER_ID);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    await store.put('agents', makeAgent('agt-a'));
    await store.put('agents', makeAgent('agt-b'));
  });

  it('steers only the mentioned room member in the current conversation', async () => {
    const convId = await room(['agt-a', 'agt-b']);
    const send = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', {
      text: 'ping @agt-a',
      mentions: [{ kind: 'agent', id: 'agt-a', label: '@Agent agt-a' }],
    }));
    expect(send.status, await send.clone().text()).toBe(202);
    expect(enqueuer.wakes.map((w) => w.agentId)).toEqual(['agt-a']);
    expect(enqueuer.wakes.map((w) => w.mode)).toEqual(['steer']);
    expect(enqueuer.wakes.map((w) => w.conversationId)).toEqual([convId]);
    expect(enqueuer.wakes.map((w) => w.kind)).toEqual(['room_mention']);
  });

  it('steers the direct peer in the current conversation', async () => {
    const created = await call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-a'] });
    expect(created.status, await created.clone().text()).toBe(201);
    const convId = stringField(await created.json(), 'id');
    const send = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', { text: 'hi' }));
    expect(send.status, await send.clone().text()).toBe(202);
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]?.mode).toBe('steer');
    expect(enqueuer.wakes[0]?.conversationId).toBe(convId);
    expect(enqueuer.wakes[0]?.kind).toBe('user_message');
  });

  it('returns the run Session named for the message', async () => {
    enqueuer.decide = () => ({ accepted: true, runId: 'run_named' });
    const created = await call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-a'] });
    const convId = stringField(await created.json(), 'id');
    const send = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', { text: 'hi' }));
    expect(send.status, await send.clone().text()).toBe(202);
    const body: unknown = await send.json();
    expect(body).toMatchObject({ runId: 'run_named', item: { type: 'user_message', text: 'hi' } });
  });

  // With no single durable run to name, the response echoes the wire runId the client supplied (AG-UI RunAgentInput.runId).
  it('names no durable run when one message wakes several agents', async () => {
    enqueuer.decide = () => ({ accepted: true, runId: 'run_one' });
    const convId = await room(['agt-a', 'agt-b']);
    const input = aguiInput('/v1/conversations/' + convId + '/runs', {
      text: 'hi all',
      mentions: [{ kind: 'agent', id: 'everyone', label: '@everyone' }],
    });
    const send = await call('/v1/conversations/' + convId + '/runs', 'POST', input);
    expect(send.status, await send.clone().text()).toBe(202);
    expect(enqueuer.wakes).toHaveLength(2);
    const body: unknown = await send.json();
    expect(body).toMatchObject({ runId: input['runId'] });
    expect(body).not.toMatchObject({ runId: 'run_one' });
  });

  it('names no durable run when the message wakes nobody', async () => {
    const convId = await room(['agt-a', 'agt-b']);
    const input = aguiInput('/v1/conversations/' + convId + '/runs', { text: 'just talking' });
    const send = await call('/v1/conversations/' + convId + '/runs', 'POST', input);
    expect(send.status, await send.clone().text()).toBe(202);
    expect(enqueuer.wakes).toHaveLength(0);
    expect(await send.json()).toMatchObject({ runId: input['runId'] });
  });

  it('answers 503 when Session refuses the wake, because the message was stored but not queued', async () => {
    enqueuer.decide = () => ({ accepted: false, reason: 'hop_limit' });
    const created = await call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-a'] });
    const convId = stringField(await created.json(), 'id');
    const send = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', { text: 'hi' }));
    expect(send.status).toBe(503);
    expect(await send.json()).toMatchObject({ error: { code: 'WAKE_ENQUEUE_FAILED' } });
  });

  it('steers a room first message to the mentioned member in the created conversation', async () => {
    const created = await call('/v1/conversations', 'POST', {
      kind: 'room',
      memberAgentIds: ['agt-a', 'agt-b'],
      firstMessage: { text: 'ping @agt-a', mentions: [{ kind: 'agent', id: 'agt-a', label: '@Agent agt-a' }] },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const convId = stringField(await created.json(), 'id');
    expect(enqueuer.wakes.map((w) => w.mode)).toEqual(['steer']);
    expect(enqueuer.wakes.map((w) => w.conversationId)).toEqual([convId]);
  });
});
