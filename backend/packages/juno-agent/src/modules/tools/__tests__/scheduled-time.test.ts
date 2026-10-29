import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createWaitForTool } from '../tools/waitFor.js';
import { createWakeAtTool } from '../tools/wakeAt.js';

function setup() {
  const store = createMemoryStore();
  const enqueuer = new NoopEnqueuer();
  const ctx: ToolContext = {
    ownerId: 'owner-a', agentId: 'agent-a', conversationId: 'chat-a', runId: 'run-a',
    store, blobs: createMemoryBlobStore(), enqueuer, signal: new AbortController().signal, step: async (_name, action) => action(),
    wake: { id: 'wake-a', ownerId: 'owner-a', agentId: 'agent-a', conversationId: 'chat-a',
      sessionKey: 'agent-a:chat-a', kind: 'user_message', origin: { type: 'user' },
      trusted: true, priority: 'user', payload: {}, at: '2026-10-08T00:00:00Z', status: 'accepted' },
  };
  return { store, enqueuer, ctx };
}

afterEach(() => vi.useRealTimers());

describe('scheduled tool times', () => {
  it.each([['1h', 3_600_000], ['+2m', 120_000], ['5000', 5000]])('wait_for parses %s completely', async (timeout, ms) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
    const deps = setup();
    const result = await createWaitForTool(deps).execute({ filter: {}, timeout }, deps.ctx);
    expect(result.suspend?.until).toBe(new Date(Date.now() + ms).toISOString());
    expect((await deps.store.list('subscriptions')).items).toHaveLength(1);
  });

  it.each(['-1', '0', 'garbage', '1h trailing', 'Infinity'])('wait_for refuses invalid %s before storing', async timeout => {
    const deps = setup();
    await expect(createWaitForTool(deps).execute({ filter: {}, timeout }, deps.ctx)).rejects.toThrow();
    expect((await deps.store.list('subscriptions')).items).toHaveLength(0);
  });

  it('wake_at honors relative minutes instead of silently substituting one hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
    const deps = setup();
    expect((await createWakeAtTool(deps).execute({ when: '+2m' }, deps.ctx)).suspend?.until).toBe('2026-10-08T00:02:00.000Z');
    await expect(createWakeAtTool(deps).execute({ when: 'garbage' }, deps.ctx)).rejects.toThrow();
  });
});
