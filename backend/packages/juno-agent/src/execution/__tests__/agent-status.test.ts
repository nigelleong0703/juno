/** The status line under an agent's name never shows background upkeep or an unprocessed @mention message. */
import { describe, expect, it } from 'vitest';
import type { Run } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../testing/store.js';
import { agentStatus } from '../agent-status.js';

const AT = '2026-10-15T00:00:00.000Z';
const run = (id: string, title: string, extra: Partial<Run> = {}): Run => ({
  id, agentId: 'agt-1', title, status: 'running', kind: 'chat', steps: [], startedAt: AT, lastActivityAt: AT,
  usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, ...extra,
});

describe('agent status doing line', () => {
  it('ignores background runs and raw @mention titles', async () => {
    const store = createMemoryStore();
    await store.put('runs', run('r1', 'Memory: hourly', { kind: 'background', lastActivityAt: '2026-10-15T00:05:00.000Z' }));
    expect((await agentStatus(store, 'agt-1')).doing).toBeUndefined();
    await store.put('runs', run('r2', '@all Hello everyone!', { lastActivityAt: '2026-10-15T00:06:00.000Z' }));
    expect((await agentStatus(store, 'agt-1')).doing).toBeUndefined();
    await store.put('runs', run('r3', 'Compare Mac mini prices', { lastActivityAt: '2026-10-15T00:07:00.000Z' }));
    expect((await agentStatus(store, 'agt-1')).doing).toBe('Compare Mac mini prices');
  });
});
