import { describe, expect, it } from 'vitest';
import type { ObjectContext } from '@agent-desktop/durable';
import type { Routine } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../../testing/store.js';
import { RecordingEnqueuer } from '../../../testing/enqueuer.js';
import { createRoutineTimerHandlers, routinesDeliveringTo } from '../routineTimer.js';
import type { TimerState } from '../routineTimer-state.js';

const NOW = '2026-10-09T01:00:00.000Z';
const EARLY = '2026-10-09T00:00:00.000Z';
const routine: Routine & { ownerId: string } = {
  id: 'routine', ownerId: 'owner', agentId: 'agent', name: 'QA',
  instructions: 'Actual instructions', trigger: { kind: 'schedule', cron: '*/5 * * * *', human: '5 minutes', tz: 'UTC' },
  delivery: { channel: 'chat', target: 'chat' }, notify: { mode: 'never' },
  enabled: true, status: 'active', runs: [], createdAt: EARLY,
};

/** A replay retains successful journal entries but discards uncommitted object state. */
function invocation(state: Map<string, unknown>, now = NOW, key = 'routine') {
  const journal = new Map<string, unknown>();
  const initial = structuredClone(state.get('state'));
  let insideRun = false;
  let failSet = false;
  const sends: unknown[] = [];
  function durable() { expect(insideRun).toBe(false); }
  const ctx = {
    key,
    date: { now: async () => { durable(); return Date.parse(now); } },
    get: async () => { durable(); return structuredClone(initial); },
    set: (name: string, value: unknown) => {
      durable();
      if (failSet) { failSet = false; throw new Error('restart before state commit'); }
      state.set(name, structuredClone(value));
    },
    run: async (name: string, action: () => Promise<unknown>) => {
      if (journal.has(name)) return structuredClone(journal.get(name));
      insideRun = true;
      try { const value = await action(); journal.set(name, structuredClone(value)); return value; }
      finally { insideRun = false; }
    },
    objectSendClient: () => {
      durable();
      return { fire: (p: unknown) => sends.push(p), arm: (p: unknown) => sends.push(p), receive: (p: unknown) => sends.push(p) };
    },
    objectClient: () => { durable(); return { getState: async () => ({}) }; },
  } as unknown as ObjectContext;
  return { ctx, sends, failNextSet: () => { failSet = true; } };
}

async function setup() {
  const store = createMemoryStore();
  await store.put('routines', routine);
  await store.put('agents', { id: 'agent', name: 'Agent' } as never);
  await store.put('conversations', {
    id: 'chat', kind: 'direct', agentIds: ['agent'], memberIds: ['owner'],
    unreadCount: 0, lastItemAt: NOW, createdAt: EARLY,
  });
  return { store, handlers: createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer() }) };
}

describe('routine durable replay boundary', () => {
  it('recovers streak and pause after history persists but state commit fails', async () => {
    const { store, handlers } = await setup();
    const state = new Map<string, unknown>();
    const call = invocation(state);
    const params = { routineId: 'routine', runId: 'run', occurrenceAt: EARLY, succeeded: true, itemsGenerated: 5, outputIds: ['output'] };
    call.failNextSet();
    await expect(handlers.recordCompletion(call.ctx, params)).rejects.toThrow('restart');
    expect((await store.get('routines', 'routine'))?.runs).toHaveLength(1);
    await handlers.recordCompletion(call.ctx, params);
    expect(state.get('state')).toMatchObject({ unreadStreak: 5, pausedAt: NOW, lastResultAt: NOW });
    expect((await store.get('routines', 'routine'))?.enabled).toBe(false);
    expect((await store.get('routines', 'routine'))?.runs[0]?.finishedAt).toBe(NOW);
    await handlers.recordCompletion(invocation(state).ctx, params);
    expect(state.get('state')).toMatchObject({ unreadStreak: 5 });
    expect((await store.get('routines', 'routine'))?.runs).toHaveLength(1);
  });

  it('late read cannot clear output completed after its scheduled occurrence', async () => {
    const { store, handlers } = await setup();
    const state = new Map<string, unknown>();
    await handlers.recordCompletion(invocation(state).ctx, {
      routineId: 'routine', runId: 'run', occurrenceAt: EARLY, succeeded: true, itemsGenerated: 1, outputIds: ['output'],
    });
    await handlers.recordRead(invocation(state).ctx, { routineId: 'routine', conversationId: 'chat', readCutoff: EARLY, resultIds: [] });
    expect(state.get('state')).toMatchObject({ unreadStreak: 1 });
    await handlers.recordRead(invocation(state).ctx, { routineId: 'routine', conversationId: 'chat', readCutoff: NOW, resultIds: [] });
    expect(state.get('state')).toMatchObject({ unreadStreak: 1, lastReadCutoff: EARLY });
    const read = invocation(state);
    read.failNextSet();
    const receipt = { routineId: 'routine', conversationId: 'chat', readCutoff: NOW, resultIds: ['output'] };
    await expect(handlers.recordRead(read.ctx, receipt)).rejects.toThrow('restart');
    await handlers.recordRead(read.ctx, receipt);
    expect(state.get('state')).toMatchObject({ unreadStreak: 0, lastReadResultIds: ['output'] });
    await handlers.recordCompletion(invocation(state, '2026-10-09T02:00:00.000Z').ctx, {
      routineId: 'routine', runId: 'newer', succeeded: true, itemsGenerated: 1,
    });
    await handlers.recordRead(invocation(state).ctx, receipt);
    expect(state.get('state')).toMatchObject({ unreadStreak: 1 });
    expect((await store.get('routines', 'routine'))?.lastReadAt).toBe(NOW);
  });

  it('rejects cross-key arm, fire, completion and read without mutation', async () => {
    const { store, handlers } = await setup();
    const state = new Map<string, unknown>();
    const call = invocation(state, NOW, 'foreign');
    await handlers.arm(call.ctx, routine);
    await handlers.fire(call.ctx, { routineId: 'routine', at: NOW, generation: 0 });
    await handlers.recordCompletion(call.ctx, { routineId: 'routine', succeeded: false, itemsGenerated: 0 });
    await handlers.recordRead(call.ctx, { routineId: 'routine', conversationId: 'chat', readCutoff: NOW, resultIds: [] });
    expect(state.size).toBe(0);
    expect(call.sends).toEqual([]);
    expect((await store.get('routines', 'routine'))?.runs).toEqual([]);
  });

  it('replays arm and fire using durable time without SDK calls inside run', async () => {
    const { handlers } = await setup();
    const state = new Map<string, unknown>();
    const arm = invocation(state);
    await handlers.arm(arm.ctx, routine);
    const saved = state.get('state') as TimerState;
    expect(saved.nextRunAtTime).toBe('2026-10-09T01:05:00.000Z');
    const fire = invocation(state, saved.nextRunAtTime);
    await handlers.fire(fire.ctx, { routineId: 'routine', at: saved.nextRunAtTime!, generation: 1 });
    expect(state.get('state')).toMatchObject({ lastFiredAt: saved.nextRunAtTime });
    expect(fire.sends.length).toBeGreaterThan(1);
  });

  it('finds actual delivery routines beyond 500 records', async () => {
    const { store } = await setup();
    for (let i = 0; i < 610; i += 1) await store.put('routines', { ...routine, id: `routine-${i}` });
    expect(await routinesDeliveringTo(store, 'chat')).toHaveLength(611);
  });

  it('does not re-enable a paused routine from an old queued arm', async () => {
    const { store, handlers } = await setup();
    await store.patch('routines', routine.id, { enabled: false, status: 'paused' });
    const state = new Map<string, unknown>();
    const call = invocation(state);
    await handlers.arm(call.ctx, routine);
    expect(call.sends).toEqual([]);
    expect(state.get('state')).toMatchObject({ armed: false });
  });
});
