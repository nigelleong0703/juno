/** The status line under an agent's name never shows background upkeep or an unprocessed @mention message; a plain reply is typing, not working. */
import { describe, expect, it } from 'vitest';
import type { Run } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../testing/store.js';
import { agentStatus, announceFirstStep } from '../agent-status.js';

const AT = '2026-10-15T00:00:00.000Z';
const run = (id: string, title: string, extra: Partial<Run> = {}): Run => ({
  id, agentId: 'agt-1', title, status: 'running', kind: 'chat', steps: [], startedAt: AT, lastActivityAt: AT,
  usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, ...extra,
});
const step = (id: string, runId: string, extra: Record<string, unknown> = {}) =>
  ({ id, runId, index: 0, kind: 'mcp', status: 'running', startedAt: AT, durationMs: 0, ...extra }) as never;

describe('agent status doing line', () => {
  it('ignores background runs and raw @mention titles', async () => {
    const store = createMemoryStore();
    await store.put('runs', run('r1', 'Memory: hourly', { kind: 'background', lastActivityAt: '2026-10-15T00:05:00.000Z' }));
    expect((await agentStatus(store, 'agt-1')).doing).toBeUndefined();
    await store.put('runs', run('r2', '@all Hello everyone!', { kind: 'routine', lastActivityAt: '2026-10-15T00:06:00.000Z' }));
    expect((await agentStatus(store, 'agt-1')).doing).toBeUndefined();
    await store.put('runs', run('r3', 'Compare Mac mini prices', { kind: 'routine', lastActivityAt: '2026-10-15T00:07:00.000Z' }));
    expect((await agentStatus(store, 'agt-1')).doing).toBe('Compare Mac mini prices');
  });
});

describe('a plain chat reply is typing, not working', () => {
  it('is idle until the run has a step a person can see, then working (a running step counts)', async () => {
    const store = createMemoryStore();
    await store.put('runs', run('r1', 'hello'));
    expect((await agentStatus(store, 'agt-1')).status).toBe('idle');

    // Plumbing (finding a tool) is not work a person can see.
    await store.put('steps', step('s0', 'r1', { internal: true }), { runId: 'r1' });
    expect((await agentStatus(store, 'agt-1')).status).toBe('idle');

    // The first visible tool call is still running: it is only in the steps collection, not yet on the run row.
    await store.put('steps', step('s1', 'r1'), { runId: 'r1' });
    expect((await agentStatus(store, 'agt-1')).status).toBe('working');
  });

  it('a routine run is working from the start', async () => {
    const store = createMemoryStore();
    await store.put('runs', run('r1', 'Morning brief', { kind: 'routine' }));
    expect((await agentStatus(store, 'agt-1')).status).toBe('working');
  });

  it('announces the status once, at the first visible step', async () => {
    const store = createMemoryStore();
    const events: unknown[] = [];
    const emit = store.emit.bind(store);
    store.emit = async (event) => { events.push(event); return emit(event); };
    await store.put('runs', run('r1', 'hello'));
    await store.put('steps', step('s0', 'r1', { internal: true }), { runId: 'r1' });
    await announceFirstStep(store, 'r1', { id: 's0', internal: true });
    expect(events).toEqual([]);
    await store.put('steps', step('s1', 'r1'), { runId: 'r1' });
    await announceFirstStep(store, 'r1', { id: 's1' });
    expect(events).toMatchObject([{ type: 'agent.status', agentId: 'agt-1', status: 'working' }]);
    await store.put('steps', step('s2', 'r1'), { runId: 'r1' });
    await announceFirstStep(store, 'r1', { id: 's2' });
    expect(events).toHaveLength(1);
  });
});
