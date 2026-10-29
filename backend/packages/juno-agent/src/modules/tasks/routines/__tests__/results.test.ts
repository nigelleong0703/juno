import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../../testing/store.js';
import type { Routine } from '@agent-desktop/public-contracts';
import { appendRoutineRun, collectRoutineOutputs, resultIdsForHistory, writePauseNotice } from '../results.js';

const NOW = '2026-10-09T00:00:00.000Z';

function routine(): Routine {
  return {
    id: 'rtn-1',
    agentId: 'agent-1',
    name: 'Morning brief',
    instructions: 'Summarize',
    trigger: { kind: 'schedule', human: 'Daily', tz: 'UTC' },
    delivery: { channel: 'chat', target: 'conv-1' },
    notify: { mode: 'always' },
    enabled: true,
    status: 'active',
    runs: [],
    createdAt: NOW,
  };
}

async function bubble(store: ReturnType<typeof createMemoryStore>, id: string, runId: string | undefined, at: string) {
  await store.put('items', {
    id,
    conversationId: 'conv-1',
    type: 'agent_message',
    agentId: 'agent-1',
    ...(runId === undefined ? {} : { runId }),
    markdown: 'result',
    citations: [],
    at,
  }, { conversationId: 'conv-1', ...(runId === undefined ? {} : { runId }) });
}

describe('routine result evidence', () => {
  it('collects this runs output ids and count in its conversation', async () => {
    const store = createMemoryStore();
    await bubble(store, 'a1', 'run-1', NOW);
    await bubble(store, 'a2', 'run-1', NOW);
    await bubble(store, 'b1', 'run-2', NOW);
    await bubble(store, 'c1', undefined, NOW);
    expect(await collectRoutineOutputs(store, 'conv-1', 'run-1')).toEqual({ ids: ['a1', 'a2'], count: 2 });
    expect(await collectRoutineOutputs(store, 'conv-1', 'run-9')).toEqual({ ids: [], count: 0 });
    expect(await collectRoutineOutputs(store, 'conv-9', 'run-1')).toEqual({ ids: [], count: 0 });
  });

  it('addresses history output ids directly past a thousand older items', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 1100; i += 1) {
      await bubble(store, 'old-' + String(i), 'run-old', '2026-10-01T00:00:00.000Z');
    }
    await bubble(store, 'latest-1', 'run-new', '2026-10-09T00:08:00.000Z');
    await bubble(store, 'latest-2', 'run-new', '2026-10-09T00:09:00.000Z');
    const withHistory: Routine = {
      ...routine(),
      runs: [{
        id: 'rr-new',
        routineId: 'rtn-1',
        status: 'completed',
        summary: 'latest',
        runId: 'run-new',
        outputIds: ['latest-1', 'latest-2'],
        startedAt: '2026-10-09T00:08:00.000Z',
        finishedAt: '2026-10-09T00:09:00.000Z',
      }],
    };
    expect(resultIdsForHistory(withHistory, '2026-10-09T00:10:00.000Z')).toEqual(['latest-1', 'latest-2']);
    expect(resultIdsForHistory(withHistory, '2026-10-09T00:08:30.000Z')).toEqual([]);
  });

  it('appends bounded history with output ids and last-run pointers', async () => {
    const store = createMemoryStore();
    const seeded = { ...routine(), ownerId: 'owner-1' };
    await store.put('routines', seeded);
    for (let i = 0; i < 22; i += 1) {
      const current = await store.get('routines', 'rtn-1');
      if (!current) throw new Error('missing routine');
      await appendRoutineRun(store, current, {
        id: 'rr-' + String(i),
        routineId: 'rtn-1',
        status: 'completed',
        summary: 'run ' + String(i),
        runId: 'run-' + String(i),
        outputIds: ['out-' + String(i)],
        startedAt: NOW,
        finishedAt: NOW,
      });
    }
    const after = await store.get('routines', 'rtn-1');
    expect(after?.runs).toHaveLength(20);
    expect(after?.runs[0]?.id).toBe('rr-2');
    expect(after?.runs[19]?.outputIds).toEqual(['out-21']);
    expect(after?.lastRunAt).toBe(NOW);
    expect(after?.lastRunStatus).toBe('completed');
  });

  it('writes a chat-local pause notice unless notify is never', async () => {
    const store = createMemoryStore();
    const id = await writePauseNotice(store, routine(), 'conv-1', 'unread', NOW);
    expect(id).toBeDefined();
    expect((await store.get('items', id as string))?.type).toBe('system');
    expect(await writePauseNotice(store, { ...routine(), notify: { mode: 'never' } }, 'conv-1', 'failed', NOW)).toBeUndefined();
  });
});
