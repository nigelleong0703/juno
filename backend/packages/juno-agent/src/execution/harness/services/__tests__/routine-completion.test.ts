/**
 * LOOP-ROUTINE1 run hook: a finished routine run reports its link, counted outputs and ids;
 * any other run reports nothing. Stopped/blocked outcomes never reach this reporter.
 */
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
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
      run: <T,>(name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
      completeRoutine: async (params: ReportParams) => {
        reported.push(params);
      },
    };
    const input = { ...routineInput(), wakeEvents: [] };
    await reportRoutineCompletion(ctx, services(store), input as never, 'run-1', { succeeded: true });
    expect(reported).toEqual([]);
  });
});
