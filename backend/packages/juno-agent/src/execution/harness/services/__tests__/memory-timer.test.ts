/** The memory schedule stops for an owner whose agents are all gone, and starts again only through arm. */
import { describe, expect, it } from 'vitest';
import type { ObjectContext } from '@agent-desktop/durable';
import { createMemoryStore } from '../../../../testing/store.js';
import type { Brain } from '../../../../contracts/index.js';
import { createMemoryTimerHandlers } from '../memory-timer.js';

describe('memory timer', () => {
  it('does nothing and does not re-arm when the owner has no agent', async () => {
    const store = createMemoryStore();
    const brain = { completeText: async () => { throw new Error('model must not be called'); } } as unknown as Brain;
    const handlers = createMemoryTimerHandlers({ store, brain });
    const state = new Map<string, unknown>([['state', { armed: true, generation: 3, nextAt: '2026-10-15T01:00:00.000Z', job: { nightly: {} } }]]);
    const sent: unknown[] = [];
    const ctx = {
      key: 'owner-gone',
      date: { now: async () => Date.parse('2026-10-15T01:00:00.000Z') },
      run: async (_name: string, action: () => Promise<unknown>) => action(),
      get: async (name: string) => state.get(name),
      set: (name: string, value: unknown) => state.set(name, value),
      objectSendClient: () => ({ fire: (p: unknown) => sent.push(p), receive: (p: unknown) => sent.push(p) }),
    } as unknown as ObjectContext;
    await handlers.fire(ctx, { generation: 3 });
    expect(sent).toHaveLength(0);
    expect(state.get('state')).toMatchObject({ armed: false });
    expect(await store.list('agentHome', { limit: 10 })).toMatchObject({ items: [] });
  });
});
