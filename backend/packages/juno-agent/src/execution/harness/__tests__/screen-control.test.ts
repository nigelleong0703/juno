/**
 * Screen control notes (BACKEND 7.8): a hand_back with source screen_control is context. It steers a live
 * run, never starts one on an idle session (it waits for the next real wake and rides in front of it), and
 * starts the session only when the takeover held up a run that ended (`resume`).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { sessionKey, type Brain, type ToolRegistry, type WakeEvent } from '../../../contracts/index.js';
import {
  receiveEvent,
  type SessionIo,
  type SessionState,
} from '../services/session.js';
import { drainInboxEvents } from '../services/session-events.js';
import { runKindFor } from '../logic/busy.js';
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

const note = (id: string, payload: Record<string, unknown>) =>
  wake(id, 'room-1', { kind: 'hand_back', origin: { type: 'system' }, trusted: false, priority: 'background', payload: { source: 'screen_control', ...payload } });
const room = (id: string) => wake(id, 'room-1', { kind: 'room_mention', payload: { text: '@everyone', addressed: 'everyone' } });

describe('screen control notes', () => {
  const services = { store: createMemoryStore(), brain: stubBrain(), toolRegistry: stubTools };

  it('starts no run on an idle session, then rides behind the next real wake', async () => {
    const h = makeSession('agt-a:room-1');
    await receiveEvent(h.io, services, note('n1', { phase: 'end', heldMs: 92_000, changes: ['tab t1 now https://x.test/ (title "Inbox")'] }));
    expect(h.started).toHaveLength(0);
    expect(h.state()!.inbox).toHaveLength(1);

    await receiveEvent(h.io, services, room('r1'));
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.input.wakeEvents.map((e) => e.id)).toEqual(['r1', 'n1']);
    expect(runKindFor(h.started[0]!.input.wakeEvents[0]!.kind)).toBe('chat');
  });

  it('steers a live run at its next boundary', async () => {
    const h = makeSession('agt-a:room-1');
    await receiveEvent(h.io, services, room('r1'));
    await receiveEvent(h.io, services, note('n1', { phase: 'start' }));
    expect(h.started).toHaveLength(1);
    expect((await drainInboxEvents(h.io)).map((e) => e.id)).toEqual(['n1']);
  });
});
