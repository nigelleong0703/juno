/**
 * LOOP-ROUTINE1 adapter integration: arm versions stale fires, reads clear only with a current cutoff, catch-up
 * caps at five with skip-if-running, occurrences never duplicate.
 */
import { describe, expect, it } from 'vitest';
import type { ObjectContext } from '@agent-desktop/durable';
import { createMemoryStore } from '../../../../testing/store.js';
import { RecordingEnqueuer } from '../../../testing/enqueuer.js';
import type { Routine } from '@agent-desktop/public-contracts';
import { createRoutineTimerHandlers } from '../routineTimer.js';
import type { TimerState } from '../routineTimer-state.js';

const NOW = '2026-10-09T00:00:00.000Z';
const DAY_AGO = '2026-10-08T00:00:00.000Z';

interface SentCall {
  service: string;
  key: string;
  handler: string;
  payload: unknown;
}

function fakeCtx(state: Map<string, unknown>, sends: SentCall[], sessionStates: Map<string, { activeRunId?: string }>, key = 'rtn-1', now = NOW) {
  return {
    key,
    date: { now: async () => Date.parse(now) },
    run: async (_name: string, action: () => Promise<unknown>) => action(),
    get: async (name: string) => state.get(name),
    set: (name: string, value: unknown) => {
      state.set(name, value);
    },
    objectSendClient: (_def: unknown, key: string) => ({
      arm: (routine: unknown) => {
        sends.push({ service: 'RoutineTimer', key, handler: 'arm', payload: routine });
      },
      fire: (params: unknown) => {
        sends.push({ service: 'RoutineTimer', key, handler: 'fire', payload: params });
      },
      receive: (event: unknown) => {
        sends.push({ service: 'Session', key, handler: 'receive', payload: event });
      },
    }),
    objectClient: (_def: unknown, key: string) => ({
      getState: async () => sessionStates.get(key) ?? { activeRunId: undefined },
    }),
  } as unknown as ObjectContext;
}

function routine(extra: Partial<Routine> = {}): Routine {
  return {
    id: 'rtn-1',
    agentId: 'agent-1',
    name: 'Morning brief',
    instructions: 'Summarize inbox',
    trigger: { kind: 'schedule', cron: '*/5 * * * *', human: 'Every 5 minutes', tz: 'UTC' },
    delivery: { channel: 'chat', target: 'conv-1' },
    notify: { mode: 'always' },
    enabled: true,
    status: 'active',
    runs: [],
    createdAt: NOW,
    ...extra,
  };
}

async function seedChat(store: ReturnType<typeof createMemoryStore>) {
  await store.put('agents', { id: 'agent-1', name: 'Agent' } as never);
  await store.put('conversations', {
    id: 'conv-1',
    kind: 'direct',
    agentIds: ['agent-1'],
    memberIds: ['owner-1'],
    unreadCount: 0,
    lastItemAt: NOW,
    createdAt: NOW,
  });
}

function receives(sends: SentCall[]) {
  return sends.filter((call) => call.handler === 'receive');
}

function receiveIds(sends: SentCall[]): string[] {
  return receives(sends).map((call) => (call.payload as { id: string }).id);
}

const AT = '2026-10-09T00:00:00.000Z';

async function fireWith(store: ReturnType<typeof createMemoryStore>, state: Map<string, unknown>, sends: SentCall[], sessionStates: Map<string, { activeRunId?: string }>) {
  const service = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer() });
  await service.fire(fakeCtx(state, sends, sessionStates), { at: AT, routineId: 'rtn-1', generation: 0 });
}

describe('routine timer adapter', () => {
  it('dedupes a retried completion by run id', async () => {
    const store = createMemoryStore();
    const owned = { ...routine(), ownerId: 'owner-1' };
    await store.put('routines', owned);
    const state = new Map<string, unknown>();
    const sends: SentCall[] = [];
    const service = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer() });
    const params = { routineId: 'rtn-1', runId: 'run-1', succeeded: true, itemsGenerated: 2 };
    await service.recordCompletion(fakeCtx(state, sends, new Map()), params);
    await service.recordCompletion(fakeCtx(state, sends, new Map()), params);
    expect((await store.get('routines', 'rtn-1'))?.runs).toHaveLength(1);
    expect(state.get('state')).toMatchObject({ unreadStreak: 2 });
  });

  it('pauses with a chat notice after five consecutive failures', async () => {
    const store = createMemoryStore();
    const failing = { ...routine(), ownerId: 'owner-1' };
    await store.put('routines', failing);
    await seedChat(store);
    const state = new Map<string, unknown>();
    const service = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer() });
    const ctx = () => fakeCtx(state, [], new Map());
    for (let i = 0; i < 5; i += 1) {
      await service.recordCompletion(ctx(), { routineId: 'rtn-1', succeeded: false, itemsGenerated: 0 });
    }
    expect((await store.get('routines', 'rtn-1'))?.enabled).toBe(false);
    expect(state.get('state')).toMatchObject({ unreadStreak: 0, failStreak: 5 });
    const notices = await store.list('items', { where: { conversationId: 'conv-1' } });
    expect(notices.items.some((item) => (item as { type: string }).type === 'system')).toBe(true);
  });
  it('versions arms so stale fires are skipped', async () => {
    const store = createMemoryStore();
    const owned = { ...routine(), ownerId: 'owner-1' };
    await store.put('routines', owned);
    await seedChat(store);
    const state = new Map<string, unknown>();
    const sends: SentCall[] = [];
    const service = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer() });
    await service.arm(fakeCtx(state, sends, new Map()), routine());
    const fire = sends.find((call) => call.handler === 'fire');
    expect(fire).toBeDefined();
    const params = (fire as SentCall).payload as { at: string; routineId: string; generation: number };
    expect(params.generation).toBe(1);
    const stale: SentCall[] = [];
    await service.fire(fakeCtx(state, stale, new Map()), { at: params.at, routineId: 'rtn-1', generation: 0 });
    await service.fire(fakeCtx(state, stale, new Map()), { at: '2000-01-01T00:00:00.000Z', routineId: 'rtn-1', generation: 1 });
    expect(receives(stale)).toHaveLength(0);
    await service.fire(fakeCtx(state, stale, new Map()), params);
    expect(receives(stale).length).toBeGreaterThan(0);
    for (const call of receives(stale)) {
      const event = call.payload as { payload: { text: string; routineId: string; occurrenceAt: string } };
      expect(event.payload.text).toContain('Summarize inbox');
      expect(event.payload.routineId).toBe('rtn-1');
    }
  });

  it('does not catch up occurrences from before the routine was armed', async () => {
    const store = createMemoryStore();
    const owned = { ...routine(), ownerId: 'owner-1' };
    await store.put('routines', owned);
    await seedChat(store);
    const state = new Map<string, unknown>();
    const sends: SentCall[] = [];
    const service = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer() });
    await service.arm(fakeCtx(state, sends, new Map(), 'rtn-1', '2026-10-09T00:02:00.000Z'), routine());
    const fire = sends.find((call) => call.handler === 'fire');
    const params = (fire as SentCall).payload as { at: string; routineId: string; generation: number };
    const fired: SentCall[] = [];
    await service.fire(fakeCtx(state, fired, new Map(), 'rtn-1', params.at), params);
    // The wake id is the due-offer key: the routine and the due second.
    expect(receiveIds(fired)).toEqual(['wake_routine_rtn-1:' + params.at.slice(0, 19) + 'Z']);
  });

  describe('late and missed fires (fake clock)', () => {
    const daily = (): Routine => routine({ trigger: { kind: 'schedule', cron: '0 9 * * *', human: 'Every day at 9', tz: 'UTC' } });
    const stateAt = (lastFiredAt: string, fired: number[] = []): Map<string, unknown> =>
      new Map<string, unknown>([['state', { routineId: 'rtn-1', armed: true, armGeneration: 0, nextRunAtTime: AT, failStreak: 0, unreadStreak: 0, firedOccurrences: fired, lastFiredAt } satisfies TimerState]]);
    const fireAt = async (store: ReturnType<typeof createMemoryStore>, state: Map<string, unknown>, now: string, sends: SentCall[]) => {
      const service = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer() });
      await service.fire(fakeCtx(state, sends, new Map(), 'rtn-1', now), { at: AT, routineId: 'rtn-1', generation: 0 });
    };
    const seed = async (): Promise<ReturnType<typeof createMemoryStore>> => {
      const store = createMemoryStore();
      const owned = { ...daily(), ownerId: 'owner-1' };
      await store.put('routines', owned);
      await seedChat(store);
      return store;
    };
    const payloadOf = (sends: SentCall[]) => (receives(sends)[0]?.payload as { id: string; payload: { text: string; late?: boolean; occurrenceAt: string } });

    it('runs once, unannounced, a fire that is late by less than the grace window', async () => {
      const store = await seed();
      const sends: SentCall[] = [];
      await fireAt(store, stateAt('2026-10-08T09:00:00.000Z', [Date.parse('2026-10-08T09:00:00.000Z')]), '2026-10-09T09:04:00.000Z', sends);
      expect(receives(sends)).toHaveLength(1);
      expect(payloadOf(sends).payload.late).toBeUndefined();
      expect(payloadOf(sends).payload.text).not.toContain('This run is late');
      expect((await store.get('routines', 'rtn-1'))?.runs).toEqual([]);
    });

    it('collapses three days offline into ONE catch-up run, tells the agent it is late, and records the skipped ones once', async () => {
      const store = await seed();
      const sends: SentCall[] = [];
      const state = stateAt('2026-10-06T09:00:00.000Z', [Date.parse('2026-10-06T09:00:00.000Z')]);
      await fireAt(store, state, '2026-10-09T15:00:00.000Z', sends);
      expect(receives(sends)).toHaveLength(1);
      const sent = payloadOf(sends);
      expect(sent.id).toBe('wake_routine_rtn-1:2026-10-09T09:00:00Z');
      expect(sent.payload).toMatchObject({ occurrenceAt: '2026-10-09T09:00:00.000Z', late: true });
      expect(sent.payload.text).toContain('This run is late');
      expect(sent.payload.text).toContain('2 earlier runs were skipped');
      const history = (await store.get('routines', 'rtn-1'))?.runs ?? [];
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: 'skipped' });
      expect(history[0]?.summary).toContain('Skipped: missed while offline (2 runs');
      // The skip is a fact about the schedule, not a run: the routine's last-run pointers do not move.
      expect((await store.get('routines', 'rtn-1'))?.lastRunStatus).toBeUndefined();

      // The same fire again (a retry, or a second worker) makes the same wake and no second history entry.
      const again: SentCall[] = [];
      await fireAt(store, stateAt('2026-10-06T09:00:00.000Z', [Date.parse('2026-10-06T09:00:00.000Z')]), '2026-10-09T15:00:00.000Z', again);
      expect(receiveIds(again)).toEqual(receiveIds(sends));
      expect((await store.get('routines', 'rtn-1'))?.runs).toHaveLength(1);
    });

    it('records the skipped runs but sends nothing when the routine has nowhere to deliver', async () => {
      const store = createMemoryStore();
      const owned = { ...daily(), ownerId: 'owner-1' };
      await store.put('routines', owned);
      await store.put('agents', { id: 'agent-1', name: 'Agent' } as never);
      const sends: SentCall[] = [];
      await fireAt(store, stateAt('2026-10-06T09:00:00.000Z', [Date.parse('2026-10-06T09:00:00.000Z')]), '2026-10-09T15:00:00.000Z', sends);
      expect(receives(sends)).toHaveLength(0);
      expect((await store.get('routines', 'rtn-1'))?.runs).toHaveLength(1);
    });
  });

  it('skips every scheduled occurrence while the session is running', async () => {
    const store = createMemoryStore();
    const owned = { ...routine(), ownerId: 'owner-1' };
    await store.put('routines', owned);
    await seedChat(store);
    const state = new Map<string, unknown>([['state', { routineId: 'rtn-1', armed: true, armGeneration: 0, nextRunAtTime: AT, failStreak: 0, unreadStreak: 0, firedOccurrences: [], lastFiredAt: DAY_AGO } satisfies TimerState]]);
    const sends: SentCall[] = [];
    await fireWith(store, state, sends, new Map([['agent-1:conv-1', { activeRunId: 'run-busy' }]]));
    expect(receives(sends)).toHaveLength(0);
    expect(sends.some(call => call.handler === 'arm')).toBe(true);
  });

  it('does nothing and does not re-arm when the routine\'s agent was deleted', async () => {
    const store = createMemoryStore();
    await store.put('routines', { ...routine(), ownerId: 'owner-1' } as never);
    const state = new Map<string, unknown>([['state', { routineId: 'rtn-1', armed: true, armGeneration: 0, nextRunAtTime: AT, failStreak: 0, unreadStreak: 0, firedOccurrences: [], lastFiredAt: DAY_AGO } satisfies TimerState]]);
    const sends: SentCall[] = [];
    await fireWith(store, state, sends, new Map());
    expect(sends).toHaveLength(0);
    expect((state.get('state') as TimerState).armed).toBe(false);
  });

  it('never redelivers occurrences across a retried fire', async () => {
    const store = createMemoryStore();
    const owned = { ...routine(), ownerId: 'owner-1' };
    await store.put('routines', owned);
    await seedChat(store);
    const first: SentCall[] = [];
    const state = new Map<string, unknown>([['state', { routineId: 'rtn-1', armed: true, armGeneration: 0, nextRunAtTime: AT, failStreak: 0, unreadStreak: 0, firedOccurrences: [], lastFiredAt: DAY_AGO } satisfies TimerState]]);
    await fireWith(store, state, first, new Map());
    const firstIds = receiveIds(first);
    expect(firstIds.length).toBeGreaterThan(0);
    const saved = state.get('state') as TimerState;
    const rewound = new Map<string, unknown>([['state', { ...saved, lastFiredAt: DAY_AGO }]]);
    const second: SentCall[] = [];
    await fireWith(store, rewound, second, new Map());
    for (const id of receiveIds(second)) expect(firstIds).not.toContain(id);
  });

  it('clears the streak only with a current read cutoff', async () => {
    const store = createMemoryStore();
    const owned = { ...routine(), ownerId: 'owner-1' };
    await store.put('routines', owned);
    await seedChat(store);
    const state = new Map<string, unknown>();
    const service = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer() });
    const sends: SentCall[] = [];
    const ctx = () => fakeCtx(state, sends, new Map(), 'rtn-1', '2026-10-09T00:05:00.000Z');
    await service.recordCompletion(ctx(), { routineId: 'rtn-1', succeeded: true, itemsGenerated: 2, occurrenceAt: '2026-10-09T00:05:00.000Z' });
    await service.recordRead(ctx(), { routineId: 'rtn-1', conversationId: 'conv-1', readCutoff: '2026-10-09T00:04:00.000Z', resultIds: [] });
    expect(state.get('state')).toMatchObject({ unreadStreak: 2 });
    await service.recordRead(ctx(), { routineId: 'rtn-1', conversationId: 'conv-9', readCutoff: '2026-10-09T00:06:00.000Z', resultIds: [] });
    expect(state.get('state')).toMatchObject({ unreadStreak: 2 });
    await service.recordRead(ctx(), { routineId: 'rtn-1', conversationId: 'conv-1', readCutoff: '2026-10-09T00:06:00.000Z', resultIds: [] });
    expect(state.get('state')).toMatchObject({ unreadStreak: 0 });
    expect((await store.get('routines', 'rtn-1'))?.lastReadAt).toBe('2026-10-09T00:06:00.000Z');
    await service.recordRead(ctx(), { routineId: 'rtn-1', conversationId: 'conv-1', readCutoff: '2026-10-09T00:05:00.000Z', resultIds: [] });
    expect(state.get('state')).toMatchObject({ unreadStreak: 0 });
  });
});
