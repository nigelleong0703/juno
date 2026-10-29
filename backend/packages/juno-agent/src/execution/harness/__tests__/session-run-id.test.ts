/**
 * The run a user message is in is named by Session's decision: a message that starts a run gets that run's id; one that
 * joins a private quiet window gets the id the window will start (named before the window closes, and the run it starts
 * is that same id); one that steers a busy run gets the busy run. A followup names no run.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { WakeEvent } from '../../../contracts/index.js';
import { flushInboxEvent, receiveEvent, type SessionIo, type SessionState } from '../services/session.js';

const AT = '2026-10-26T00:00:00.000Z';
const OWNER = 'owner-run-id';
const AGENT = 'agent-run-id';
const CONV = 'conv-run-id';
const KEY = AGENT + ':' + CONV;

function message(id: string, overrides: Partial<WakeEvent> = {}): WakeEvent {
  return {
    id, ownerId: OWNER, agentId: AGENT, sessionKey: KEY, conversationId: CONV, kind: 'user_message',
    origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: id, addressed: 'direct' }, at: AT, status: 'accepted', mode: 'steer',
    ...overrides,
  };
}

/** A session over one conversation of the given kind, with a recording io: the runs it starts and the flushes it arms. */
async function session(kind: 'direct' | 'room') {
  const raw = createMemoryStore();
  if (raw.forOwner === undefined) throw new Error('Owner scope required');
  const store = raw.forOwner(OWNER);
  await store.put('conversations', { id: CONV, kind, agentIds: [AGENT], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT });
  let state: SessionState | null = null;
  let runs = 0;
  const started: string[] = [];
  const flushes: string[] = [];
  const io: SessionIo = {
    key: KEY,
    readState: async () => state,
    writeState: (next) => { state = next; },
    now: async () => Date.now(),
    newRunId: () => 'run-' + String(++runs),
    deliver: () => {},
    scheduleFlush: (token) => { flushes.push(token); },
    scheduleIdleCompact: () => {},
    startRun: (runId) => { started.push(runId); },
    cancelRun: () => {},
  };
  const services = { store, brain: {} as never, toolRegistry: { forAgent: async () => [], get: () => undefined } };
  return {
    started,
    flushes,
    receive: (event: WakeEvent) => receiveEvent(io, services, event),
    flush: (token: string) => flushInboxEvent(io, token),
  };
}

describe('Session names the run of a user message', () => {
  it('names the run an idle room message starts, now', async () => {
    const s = await session('room');
    expect(await s.receive(message('m1'))).toEqual({ accepted: true, runId: 'run-1' });
    expect(s.started).toEqual(['run-1']);
  });

  it('names the run a private message will start before the quiet window closes, and that run is the one started', async () => {
    const s = await session('direct');
    expect(await s.receive(message('m1'))).toEqual({ accepted: true, runId: 'run-1' });
    // A second message in the same window joins it: the same run id, the window re-armed.
    expect(await s.receive(message('m2'))).toEqual({ accepted: true, runId: 'run-1' });
    expect(s.started).toEqual([]);
    const latest = s.flushes[s.flushes.length - 1];
    expect(latest).toBeDefined();
    // The superseded window's timer does nothing; the newest one starts the run it named.
    await s.flush(s.flushes[0] ?? '');
    expect(s.started).toEqual([]);
    await s.flush(latest ?? '');
    expect(s.started).toEqual(['run-1']);
  });

  it('names the busy run a steered message goes into', async () => {
    const s = await session('room');
    await s.receive(message('m1'));
    expect(await s.receive(message('m2'))).toEqual({ accepted: true, runId: 'run-1' });
    expect(s.started).toEqual(['run-1']);
  });

  it('names no run for a followup, which waits for the next run', async () => {
    const s = await session('room');
    await s.receive(message('m1'));
    expect(await s.receive(message('m2', { mode: 'followup' }))).toEqual({ accepted: true });
  });
});
