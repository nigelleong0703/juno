/**
 * LOOP-ROUTINE1 run hook: a finished routine run reports its link, counted outputs and ids;
 * any other run reports nothing. Stopped/blocked outcomes never reach this reporter.
 */
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { DurablePromise } from '@agent-desktop/durable';
import { createMemoryStore } from '../../../../testing/store.js';
import { NoopEnqueuer } from '../../../../testing/store.js';
import type { RunServices } from '../run-types.js';
import type { Brain } from '../../../../contracts/index.js';
import { reportRoutineCompletion, type ReportParams } from '../routine-completion.js';

function services(store: ReturnType<typeof createMemoryStore>): RunServices {
  const brain = { buildContext: async () => ({ sessionKey: 's', agentId: 'a' }) } as unknown as Brain;
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: { forAgent: async () => [], get: () => undefined } };
}

function routineInput() {
  return {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    sessionKey: 'agent-1:conv-1',
    wakeEvents: [{
      id: 'wake-1',
      ownerId: 'owner-1',
      agentId: 'agent-1',
      sessionKey: 'agent-1:conv-1',
      conversationId: 'conv-1',
      kind: 'routine',
      origin: { type: 'automation', id: 'rtn-1' },
      trusted: true,
      priority: 'background',
      payload: { routineId: 'rtn-1', text: 'Summarize', occurrenceAt: '2026-10-09T00:00:00.000Z' },
      at: '2026-10-09T00:00:00.000Z',
      status: 'accepted',
    }],
  };
}

describe('routine completion reporting', () => {
  it('reports nothing when no routine started the run', async () => {
    const store = createMemoryStore();
    const reported: ReportParams[] = [];
    const ctx = {
      run: <T,>(name: string, action: () => Promise<T>): DurablePromise<T> => DurablePromise.resolve(action()),
      completeRoutine: async (params: ReportParams) => {
        reported.push(params);
      },
    };
    const input = { ...routineInput(), wakeEvents: [] };
    await reportRoutineCompletion(ctx, services(store), input as never, 'run-1', { succeeded: true });
    expect(reported).toEqual([]);
  });

  describe('a run that failed because the model provider was unavailable', () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const seedRun = (store: ReturnType<typeof createMemoryStore>, nobodyWaiting: boolean) => store.put('runs', {
      id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title: 'Routine', status: 'running', kind: 'routine', steps: [], startedAt, lastActivityAt: startedAt,
      usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      origin: nobodyWaiting ? { type: 'routine', routineId: 'rtn-1', occurrenceAt: startedAt } : { type: 'owner_message', conversationId: 'conv-1' },
      ...(nobodyWaiting ? { nobodyWaiting } : {}),
    } as never);
    const report = async (store: ReturnType<typeof createMemoryStore>, outage: { retryAfterMs?: number } | undefined): Promise<ReportParams> => {
      let reported: ReportParams | undefined;
      const ctx = {
        run: <T,>(_name: string, action: () => Promise<T>): DurablePromise<T> => DurablePromise.resolve(action()),
        completeRoutine: async (params: ReportParams) => { reported = params; },
      };
      await reportRoutineCompletion(ctx, services(store), routineInput() as never, 'run-1', { succeeded: false, summary: 'Model quota exhausted (429)', ...(outage === undefined ? {} : { providerOutage: outage }) });
      if (reported === undefined) throw new Error('nothing reported');
      return reported;
    };

    it('plans the same occurrence again, after the longer of the announced wait and five minutes', async () => {
      const store = createMemoryStore();
      await seedRun(store, true);
      const reported = await report(store, { retryAfterMs: 600_000 });
      expect(reported.refire).toMatchObject({ delayMs: 600_000, wake: { id: 'wake-1_r1', payload: { occurrenceAt: '2026-10-09T00:00:00.000Z', retry: { attempt: 1, firstAttemptAt: startedAt } } } });
    });

    it('counts it as it always did when it is not an outage, or when a person was waiting', async () => {
      const plain = createMemoryStore();
      await seedRun(plain, true);
      expect((await report(plain, undefined)).refire).toBeUndefined();
      const attended = createMemoryStore();
      await seedRun(attended, false);
      expect((await report(attended, {})).refire).toBeUndefined();
    });
  });
});
