import { aguiInput } from '../../../../../tests/agui-input.js';
/**
 * GH2 reply admission.
 *
 * Groups are mention-only: only an explicit member @mention or the `@everyone`/`@all` alias wakes an
 * agent — never an implicit host, open floor or first member. Private messages coalesce behind a
 * durable 1 s idle window that a typing user extends (and a 30 s cap ends), and a wake an agent sent to itself is refused. There is no model reply decision:
 * every admitted wake starts its batch. All deterministic: memory store + pure session logic, no
 * live model call and no user data change.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import {
  sessionKey,
  type Brain,
  type Enqueuer,
  type Store,
  type ToolRegistry,
  type WakeEvent,
} from '@agent-desktop/contracts';
import type { Agent, Conversation, Item } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import {
  MAX_TYPING_HOLD_MS,
  PRIVATE_IDLE_WINDOW_MS,
  selfWakeAdmission,
  TYPING_TTL_MS,
} from 'juno-agent/execution/harness/logic/idle';
import { flushInboxEvent, receiveEvent, type SessionIo, type SessionState } from 'juno-agent/execution/harness/services/session';
import type { RunInput } from 'juno-agent/execution/harness/services/run-types';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-06T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Group / typing admission over HTTP
// ---------------------------------------------------------------------------

class RecordingEnqueuer implements Enqueuer {
  wakes: WakeEvent[] = [];

  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string }> {
    this.wakes.push(event);
    return { accepted: true };
  }

  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

function makeAgent(id: string, extra: Partial<Agent> = {}): Agent {
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
    ...extra,
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

function countUserMessages(items: Item[]): number {
  let count = 0;
  for (const item of items) if (item.type === 'user_message') count += 1;
  return count;
}

describe('group wake admission over HTTP', () => {
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

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, getConfig().OWNER_ID);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    await store.put('agents', makeAgent('agt-a'));
    await store.put('agents', makeAgent('agt-b'));
  });

  it('wakes nobody for an un-mentioned group message even with open_floor + host set', async () => {
    const res = await call('/v1/conversations', 'POST', {
      kind: 'room',
      memberAgentIds: ['agt-a', 'agt-b'],
      roomMode: 'open_floor',
      hostAgentId: 'agt-b',
      firstMessage: { text: 'sync up' },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const convId = stringField(await res.json(), 'id');
    expect(countUserMessages((await store.list('items', { where: { conversationId: convId } })).items)).toBe(1);
    expect(enqueuer.wakes).toEqual([]);
  });

  it('wakes every member only for the @everyone alias', async () => {
    const res = await call('/v1/conversations', 'POST', {
      kind: 'room',
      memberAgentIds: ['agt-a', 'agt-b'],
      firstMessage: { text: '@everyone sync', mentions: [{ kind: 'agent', id: 'everyone', label: '@everyone' }] },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(enqueuer.wakes.map((w) => w.agentId).sort()).toEqual(['agt-a', 'agt-b']);
    expect(enqueuer.wakes.map((w) => w.kind)).toEqual(['room_mention', 'room_mention']);
  });

  it('wakes only the explicitly mentioned member', async () => {
    const res = await call('/v1/conversations', 'POST', {
      kind: 'room',
      memberAgentIds: ['agt-a', 'agt-b'],
      firstMessage: { text: 'ping @agt-a', mentions: [{ kind: 'agent', id: 'agt-a', label: '@Agent agt-a' }] },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(enqueuer.wakes.map((w) => w.agentId)).toEqual(['agt-a']);
    expect(enqueuer.wakes[0]?.payload['addressed']).toBe('member');
  });

  it('does not wake anyone for an un-mentioned message sent to an existing room', async () => {
    const created = await call('/v1/conversations', 'POST', {
      kind: 'room',
      memberAgentIds: ['agt-a', 'agt-b'],
      roomMode: 'open_floor',
    });
    const convId = stringField(await created.json(), 'id');
    const send = await call('/v1/conversations/' + convId + '/runs', 'POST', aguiInput('/v1/conversations/' + convId + '/runs', { text: 'still nobody?' }));
    expect(send.status, await send.clone().text()).toBe(202);
    expect(enqueuer.wakes).toEqual([]);
  });

  it('wakes only the agent that asked when a room question is answered, and the answer message mentions it', async () => {
    const created = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a', 'agt-b'] });
    const convId = stringField(await created.json(), 'id');
    await store.put('requests', {
      id: 'req-q',
      kind: 'question',
      status: 'pending',
      title: 'Question',
      summary: 'Which city?',
      agentId: 'agt-b',
      conversationId: convId,
      createdAt: AT,
      payload: { kind: 'question', ui: { version: 1, blocks: [{ type: 'choices', id: 'city', options: [{ id: 'sg', label: 'Singapore' }, { id: 'ldn', label: 'London' }] }] } },
    });
    const answered = await call('/v1/requests/req-q/resolve', 'POST', { action: 'answer', answers: { city: 'sg' } });
    expect(answered.status, await answered.clone().text()).toBe(200);
    const items = (await store.list('items', { where: { conversationId: convId } })).items;
    const message = items.find((item) => item.type === 'user_message');
    expect(message).toMatchObject({ text: 'Singapore', mentions: [{ kind: 'agent', id: 'agt-b', label: '@Agent agt-b' }] });
    expect(enqueuer.wakes.map((w) => w.agentId)).toEqual(['agt-b']);
  });

  it('forwards a private typing ping (true and false) as a wake and ignores rooms', async () => {
    const direct = await call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-a'] });
    const directId = stringField(await direct.json(), 'id');
    const ping = await call('/v1/conversations/' + directId + '/typing', 'POST', { active: true });
    expect(ping.status).toBe(204);
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]?.kind).toBe('typing');
    expect(enqueuer.wakes[0]?.payload['active']).toBe(true);
    expect(enqueuer.wakes[0]?.agentId).toBe('agt-a');

    enqueuer.wakes = [];
    const stop = await call('/v1/conversations/' + directId + '/typing', 'POST', { active: false });
    expect(stop.status).toBe(204);
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]?.payload['active']).toBe(false);

    const room = await call('/v1/conversations', 'POST', { kind: 'room', memberAgentIds: ['agt-a', 'agt-b'] });
    const roomId = stringField(await room.json(), 'id');
    enqueuer.wakes = [];
    const roomPing = await call('/v1/conversations/' + roomId + '/typing', 'POST', { active: true });
    expect(roomPing.status).toBe(204);
    expect(enqueuer.wakes).toEqual([]);
  });

  it('rejects a malformed typing body and an unknown conversation', async () => {
    const conv = await call('/v1/conversations', 'POST', { kind: 'direct', memberAgentIds: ['agt-a'] });
    const convId = stringField(await conv.json(), 'id');
    const bad = await call('/v1/conversations/' + convId + '/typing', 'POST', { active: 'yes' });
    expect(bad.status).toBe(400);
    const missing = await call('/v1/conversations/cvn-nope/typing', 'POST', { active: true });
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Pure admission helpers
// ---------------------------------------------------------------------------

describe('reply admission helpers', () => {
  it('refuses only self-wakes and missing agents (structural gate)', () => {
    expect(selfWakeAdmission({ agentId: 'a', origin: { type: 'agent', id: 'a' } })).toEqual({ admit: false, reason: 'self_wake' });
    expect(selfWakeAdmission({ agentId: '', origin: { type: 'user' } })).toEqual({ admit: false, reason: 'missing_agent' });
    expect(selfWakeAdmission({ agentId: 'a', origin: { type: 'agent', id: 'b' } }).admit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session: durable private coalescing + model reply decision
// ---------------------------------------------------------------------------

function stubBrain(): Brain {
  return {
    async buildContext(input) {
      return { sessionKey: input.sessionKey, agentId: input.agentId };
    },
    async step() {
      return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'stop' };
    },
    shouldCompact: () => false,
    async compact(ctx) {
      return ctx;
    },
  };
}

const stubTools: ToolRegistry = { forAgent: async () => [], get: () => undefined };

interface SessionHarness {
  io: SessionIo;
  started: Array<{ runId: string; input: RunInput }>;
  flushes: Array<{ token: string; delayMs: number }>;
  state: () => SessionState | null;
  /** Move the durable clock forward. */
  advance: (ms: number) => void;
}

function makeSession(key: string): SessionHarness {
  let state: SessionState | null = null;
  const started: Array<{ runId: string; input: RunInput }> = [];
  const flushes: Array<{ token: string; delayMs: number }> = [];
  let clock = Date.parse(AT);
  const io: SessionIo = {
    key,
    readState: async () => state,
    writeState: (next) => {
      state = next;
    },
    now: async () => clock,
    newRunId: () => 'run-' + (started.length + 1),
    deliver: () => {},
    scheduleIdleCompact: () => undefined,
    scheduleFlush: (token, delayMs) => {
      flushes.push({ token, delayMs });
    },
    startRun: (runId, input) => {
      started.push({ runId, input });
    },
    cancelRun: () => {},
  };
  return { io, started, flushes, state: () => state, advance: (ms) => { clock += ms; } };
}

function conversation(id: string, kind: Conversation['kind'], agentIds: string[]): Conversation {
  return { id, kind, agentIds, memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT };
}

function wake(id: string, conversationId: string, overrides: Partial<WakeEvent> = {}): WakeEvent {
  return {
    id,
    ownerId: OWNER,
    agentId: 'agt-a',
    sessionKey: sessionKey('agt-a', conversationId),
    conversationId,
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: { text: 'hi', addressed: 'direct' },
    at: AT,
    status: 'accepted',
    ...overrides,
  };
}

function agentRoomWake(id: string, conversationId: string): WakeEvent {
  return wake(id, conversationId, {
    kind: 'room_mention',
    origin: { type: 'agent', id: 'agt-b' },
    trusted: false,
    priority: 'peer',
    payload: { text: 'ping', addressed: 'everyone' },
    hop: { chainId: 'chain-1', depth: 1 },
  });
}

describe('private message coalescing', () => {
  let store: Store;
  let services: { store: Store; brain: Brain; toolRegistry: ToolRegistry };

  beforeEach(async () => {
    store = withDefaultOwner(createMemoryStore(), getConfig().OWNER_ID);
    await store.put('conversations', conversation('conv-a', 'direct', ['agt-a']));
    services = { store, brain: stubBrain(), toolRegistry: stubTools };
  });

  const typing = (id: string, active: boolean): WakeEvent =>
    wake(id, 'conv-a', { kind: 'typing', trusted: false, priority: 'background', payload: { active } });
  const lastFlush = (h: SessionHarness) => h.flushes[h.flushes.length - 1]!;

  it('a typing ping records presence; stopping clears it and restarts the 1 s window', async () => {
    const h = makeSession('agt-a:conv-a');
    await receiveEvent(h.io, services, wake('w1', 'conv-a'));
    const armed = h.flushes.length;
    h.advance(200);
    await receiveEvent(h.io, services, typing('t1', true));
    expect(h.state()!.typingUntil).toBe(Date.parse(AT) + 200 + TYPING_TTL_MS);
    expect(h.flushes).toHaveLength(armed + 1);
    h.advance(500);
    await receiveEvent(h.io, services, typing('t2', false));
    expect(h.state()!.typingUntil).toBeNull();
    expect(h.flushes).toHaveLength(armed + 2);
    expect(lastFlush(h).delayMs).toBe(PRIVATE_IDLE_WINDOW_MS);
    expect(h.started).toHaveLength(0);
  });

  it("the user's own message clears typing, so a lost false ping cannot hold the reply", async () => {
    const h = makeSession('agt-a:conv-a');
    await receiveEvent(h.io, services, typing('t1', true));
    await receiveEvent(h.io, services, wake('w1', 'conv-a'));
    expect(h.state()!.typingUntil).toBeNull();
    h.advance(PRIVATE_IDLE_WINDOW_MS);
    await flushInboxEvent(h.io, lastFlush(h).token);
    expect(h.started).toHaveLength(1);
  });

  it('a typing ping with nothing pending only records presence', async () => {
    const h = makeSession('agt-a:conv-a');
    await receiveEvent(h.io, services, typing('tp', true));
    expect(h.flushes).toHaveLength(0);
    expect(h.started).toHaveLength(0);
    expect(h.state()!.typingUntil).toBe(Date.parse(AT) + TYPING_TTL_MS);
  });

  it('the flush stops waiting after the hold cap even if they keep typing', async () => {
    const h = makeSession('agt-a:conv-a');
    await receiveEvent(h.io, services, wake('w1', 'conv-a'));
    h.advance(MAX_TYPING_HOLD_MS - 500);
    await receiveEvent(h.io, services, typing('t1', true));
    await flushInboxEvent(h.io, lastFlush(h).token);
    expect(h.started).toHaveLength(0); // still inside the cap: held
    h.advance(600);
    await receiveEvent(h.io, services, typing('t2', true));
    await flushInboxEvent(h.io, lastFlush(h).token);
    expect(h.started).toHaveLength(1);
  });

  it('keeps busy steering: while a run is active a message is queued, not coalesced', async () => {
    const h = makeSession('agt-a:conv-a');
    await receiveEvent(h.io, services, wake('w1', 'conv-a'));
    h.advance(PRIVATE_IDLE_WINDOW_MS);
    await flushInboxEvent(h.io, lastFlush(h).token);
    expect(h.started).toHaveLength(1);
    const flushCount = h.flushes.length;

    const res = await receiveEvent(h.io, services, wake('w2', 'conv-a', { payload: { text: 'busy', addressed: 'direct' } }));
    // Steered into the busy run, which is the one it names.
    expect(res).toEqual({ accepted: true, runId: 'run-1' });
    expect(h.started).toHaveLength(1);
    expect(h.flushes).toHaveLength(flushCount);
    expect(h.state()!.inbox.map((q) => q.event.id)).toEqual(['w2']);
    expect(h.state()!.inbox[0]!.mode).toBe('steer');
  });

  it('is idempotent per wake id', async () => {
    const h = makeSession('agt-a:conv-a');
    await receiveEvent(h.io, services, wake('w1', 'conv-a'));
    await receiveEvent(h.io, services, wake('w1', 'conv-a'));
    h.advance(PRIVATE_IDLE_WINDOW_MS);
    await flushInboxEvent(h.io, lastFlush(h).token);
    expect(h.started).toHaveLength(1);
    expect(h.state()!.inbox).toHaveLength(0);
  });

  it('refuses a wake an agent sent to itself', async () => {
    const h = makeSession('agt-a:conv-a');
    const self = wake('ws', 'conv-a', { origin: { type: 'agent', id: 'agt-a' }, kind: 'agent_message', trusted: false, priority: 'peer' });
    const res = await receiveEvent(h.io, services, self);
    expect(res).toEqual({ accepted: false, reason: 'self_wake' });
    expect(h.started).toHaveLength(0);
    expect(h.state()!.inbox).toHaveLength(0);
  });
});

describe('every admitted wake starts its batch (no model veto)', () => {
  let store: Store;

  beforeEach(async () => {
    store = withDefaultOwner(createMemoryStore(), getConfig().OWNER_ID);
    await store.put('conversations', conversation('room-1', 'room', ['agt-a', 'agt-b']));
    await store.put('conversations', conversation('dm-1', 'direct', ['agt-a']));
  });

  function services(): { store: Store; brain: Brain; toolRegistry: ToolRegistry } {
    return { store, brain: stubBrain(), toolRegistry: stubTools };
  }

  it('starts an ordinary peer broadcast from another agent', async () => {
    const h = makeSession('agt-a:room-1');
    const res = await receiveEvent(h.io, services(), agentRoomWake('p1', 'room-1'));
    expect(res).toMatchObject({ accepted: true });
    expect(h.started).toHaveLength(1);
  });

  it('starts an agent peer wake in a direct chat', async () => {
    const h = makeSession('agt-a:dm-1');
    const peer = wake('d1', 'dm-1', {
      kind: 'agent_message',
      origin: { type: 'agent', id: 'agt-b' },
      trusted: false,
      priority: 'peer',
    });
    const res = await receiveEvent(h.io, services(), peer);
    expect(res).toMatchObject({ accepted: true });
    expect(h.started).toHaveLength(1);
  });
});
