/** A search the provider ran inside the model call shows as the same "Looked up" step Juno's web_search gives, once, with its links as citations. */
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import type { WakeEvent } from '../../../contracts/index.js';
import { ScriptedModel } from '../testing/stubs.js';
import { recordNativeSearches } from '../services/native-search-steps.js';
import type { RunContext, RunServices } from '../services/run-types.js';

const AT = '2026-10-19T00:00:00.000Z';

function journaling(journal = new Map<string, unknown>()): RunContext {
  let next = 0;
  return {
    rand: { uuidv4: () => 'u' + String(next++) },
    run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
    },
    awakeable: () => { throw new Error('unused'); },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

describe('recordNativeSearches', () => {
  it('writes one completed Looked up step per search and returns the sources as citations; a replay writes nothing twice', async () => {
    const store = createMemoryStore();
    await store.put('runs', {
      id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title: 't', status: 'running', kind: 'chat',
      steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
    }, { conversationId: 'conv-1' });
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: { forAgent: async () => [], get: () => undefined } };
    const searches = [{ query: 'rust 2026 edition', sources: [{ title: 'Rust blog', url: 'https://blog.rust-lang.org/2026' }] }];
    const journal = new Map<string, unknown>();

    const citations = await recordNativeSearches(journaling(journal), services, 'run-1', 2, 'model:2', searches, 900);
    expect(citations).toEqual([{ id: 'web:https://blog.rust-lang.org/2026', title: 'Rust blog', url: 'https://blog.rust-lang.org/2026', source: 'web_search' }]);
    const steps = (await store.get('runs', 'run-1'))?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ verb: 'Looked up', target: 'rust 2026 edition', status: 'completed', input: { summary: expect.stringContaining('rust 2026 edition') } });
    expect(steps[0]?.output?.summary).toContain('https://blog.rust-lang.org/2026');

    await recordNativeSearches(journaling(journal), services, 'run-1', 2, 'model:2', searches, 900);
    expect((await store.get('runs', 'run-1'))?.steps).toHaveLength(1);
  });
});
