/**
 * LOOP-ROUTINE1 run finalization: each terminal outcome persists exactly its own status and
 * release semantics; only failed/completed routine runs report to their timer.
 */
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore } from '../../../../testing/store.js';
import { NoopEnqueuer } from '../../../../testing/store.js';
import type { Brain } from '../../../../contracts/index.js';
import type { RunServices } from '../run-types.js';
import type { ReportParams } from '../routine-completion.js';
import { finalizeTerminalRun } from '../run-finalize.js';

const AT = '2026-10-09T00:00:00.000Z';

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
      payload: { routineId: 'rtn-1', occurrenceAt: AT },
      at: AT,
      status: 'accepted',
    }],
  };
}

async function runningRun(store: ReturnType<typeof createMemoryStore>) {
  await store.put('runs', {
    id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title: 't',
    status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT,
  });
}

describe('run terminal finalization', () => {
  it('stops and blocks without routine reports', async () => {
    for (const kind of ['stopped', 'blocked'] as const) {
      const store = createMemoryStore();
      await runningRun(store);
      const reported: ReportParams[] = [];
      const ctx = {
        run: <T,>(name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
        completeRoutine: async (params: ReportParams) => {
          reported.push(params);
        },
      };
      await finalizeTerminalRun(ctx, services(store), routineInput() as never, 'run-1', { kind });
      expect((await store.get('runs', 'run-1'))?.status).toBe(kind);
      expect(reported).toEqual([]);
    }
  });
});
