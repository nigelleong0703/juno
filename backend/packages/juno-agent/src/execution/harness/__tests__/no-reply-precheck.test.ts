/**
 * GC10: the session runs every backend-admitted wake. There is no model reply precheck — no decider,
 * no veto and no `ctx.run('reply-precheck')` journal entry — so a wake that clears the backend gates
 * (owner authorization, dedupe, self-wake refusal, hop, rate, busy mode and private coalescing)
 * always starts its selected batch. Deterministic: memory store plus the pure session logic, no live
 * model call and no user data change.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { sessionKey, type Brain, type Store, type ToolRegistry, type WakeEvent } from '../../../contracts/index.js';
import type { Conversation } from '@agent-desktop/public-contracts';
import {
  flushInboxEvent,
  receiveEvent,
  runFinishedEvent,
  type SessionIo,
  type SessionState,
} from '../services/session.js';
import { beginRun } from '../services/session-reply.js';
import { defaultState } from '../services/session-state.js';
import type { RunInput } from '../services/run-types.js';

const AT = '2026-10-06T00:00:00.000Z';
const OWNER = 'owner-1';

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
}

/** A SessionIo double: the interface exposes no precheck hook, so a session cannot gate on the model. */
function makeSession(key: string): SessionHarness {
  let state: SessionState | null = null;
  const started: Array<{ runId: string; input: RunInput }> = [];
  const flushes: Array<{ token: string; delayMs: number }> = [];
  const io: SessionIo = {
    key,
    readState: async () => state,
    writeState: next => {
      state = next;
    },
    now: async () => Date.parse(AT),
    newRunId: () => 'run-' + (started.length + 1),
    deliver: () => {},
    scheduleIdleCompact: () => {}, scheduleFlush: (token, delayMs) => {
      flushes.push({ token, delayMs });
    },
    startRun: (runId, input) => {
      started.push({ runId, input });
    },
    cancelRun: () => {},
  };
  return { io, started, flushes, state: () => state };
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

describe('no model reply precheck', () => {
  let store: Store;
  let services: { store: Store; brain: Brain; toolRegistry: ToolRegistry };

  beforeEach(async () => {
    store = createMemoryStore();
    await store.put('conversations', conversation('conv-a', 'direct', ['agt-a']));
    await store.put('conversations', conversation('room-1', 'room', ['agt-a', 'agt-b']));
    services = { store, brain: stubBrain(), toolRegistry: stubTools };
  });

  it('beginRun starts a nonempty batch and is a no-op for an empty one', () => {
    const h = makeSession('agt-a:room-1');
    const state = defaultState();

    beginRun(h.io, state, { batch: [], rest: [] }, Date.parse(AT));
    expect(h.started).toHaveLength(0);
    expect(state.status).toBe('idle');

    const queued = {
      event: wake('b1', 'room-1', { kind: 'room_mention', payload: { text: '@everyone sync', addressed: 'everyone' } }),
      mode: 'collect' as const,
      seq: 0,
    };
    beginRun(h.io, state, { batch: [queued], rest: [] }, Date.parse(AT));
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.input.wakeEvents.map(event => event.id)).toEqual(['b1']);
    expect(state.activeRunId).toBe('run-1');
    expect(state.status).toBe('running');
  });

  it('a private message starts its run after the idle window; a second one steers into it', async () => {
    const h = makeSession('agt-a:conv-a');
    await receiveEvent(h.io, services, wake('w1', 'conv-a'));
    expect(h.started).toHaveLength(0);
    expect(h.flushes).toHaveLength(1);
    await flushInboxEvent(h.io, h.flushes[0]!.token);
    expect(h.started).toHaveLength(1);
    await receiveEvent(h.io, services, wake('w2', 'conv-a', { payload: { text: 'second', addressed: 'direct' } }));
    expect(h.started).toHaveLength(1);
    expect(h.state()!.inbox.map(q => q.event.id)).toEqual(['w2']);
    expect(h.state()!.status).toBe('running');
  });

  it('a finished run starts the queued next batch', async () => {
    const h = makeSession('agt-a:room-1');
    await receiveEvent(h.io, services, wake('r1', 'room-1', { kind: 'room_mention', payload: { text: '@everyone one', addressed: 'everyone' } }));
    expect(h.started).toHaveLength(1);
    const firstRun = h.state()!.activeRunId!;

    await receiveEvent(h.io, services, wake('r2', 'room-1', { kind: 'room_mention', payload: { text: '@everyone two', addressed: 'everyone' } }));
    expect(h.started).toHaveLength(1);
    expect(h.state()!.inbox.map(queued => queued.event.id)).toEqual(['r2']);

    await runFinishedEvent(h.io, firstRun);
    expect(h.started).toHaveLength(2);
    expect(h.started[1]!.input.wakeEvents.map(event => event.id)).toEqual(['r2']);
  });

  it('a refused self-wake starts zero runs', async () => {
    const h = makeSession('agt-a:room-1');
    const self = wake('s1', 'room-1', {
      kind: 'agent_message',
      origin: { type: 'agent', id: 'agt-a' },
      trusted: false,
      priority: 'peer',
    });
    const res = await receiveEvent(h.io, services, self);
    expect(res).toEqual({ accepted: false, reason: 'self_wake' });
    expect(h.started).toHaveLength(0);
    expect(h.state()!.inbox).toHaveLength(0);
  });

  it('an ordinary agent broadcast still starts a run', async () => {
    const h = makeSession('agt-a:room-1');
    const broadcast = wake('b1', 'room-1', {
      kind: 'room_mention',
      origin: { type: 'agent', id: 'agt-b' },
      trusted: false,
      priority: 'peer',
      payload: { text: 'standup', addressed: 'everyone' },
    });
    const res = await receiveEvent(h.io, services, broadcast);
    expect(res).toMatchObject({ accepted: true });
    expect(h.started).toHaveLength(1);
    expect(h.state()!.status).toBe('running');
  });
});
