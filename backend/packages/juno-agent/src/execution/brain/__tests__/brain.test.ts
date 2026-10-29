import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assistantMessage, toolMessage, createBrain, type ModelProvider } from '../index.js';
import type { Store } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';

describe('Brain', () => {
  let mockStore: Store;

  beforeEach(() => {
    mockStore = {
      async tx(fn) {
        return fn(mockStore);
      },
      async get() {
        return null;
      },
      async list() {
        return { items: [] };
      },
      async put(collection, doc) {
        return doc as any;
      },
      async patch() {
        return {} as any;
      },
      async delete() {},
      async emit() {},
    };
  });

  it('rebuilds complete assistant/tool history for the provider', async () => {
    const assistant = assistantMessage({ text: 'Check', toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { city: 'Singapore' } }],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'tool_calls' });
    const result = toolMessage('get_weather', 'call-1', { content: [{ type: 'text', text: 'Sunny' }] });
    const entries = [assistant, result].map((message, seq) => ({ id: `tx-${seq}`, sessionKey: 'agent-1:conv-1', seq,
      message: { ...message }, compactionEpoch: 0, at: '2026-10-05T00:00:00.000Z' }));
    const store = createMemoryStore();
    for (const entry of entries) await store.put('transcripts', entry);
    const call = vi.fn<ModelProvider['call']>().mockResolvedValue({ text: 'Done', toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'stop' });
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: { call } });
    const context = await brain.buildContext({ agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wake: [] });
    await brain.step(context, [], { signal: new AbortController().signal });
    // The assistant/tool pair arrives intact and in order; the context note is appended after it.
    const sent = call.mock.calls[0]?.[0].messages ?? [];
    const at = sent.findIndex(message => message.role === 'assistant');
    expect(sent.slice(at, at + 2)).toEqual([assistant, result]);
    expect(sent[0]?.role).toBe('system');
    expect(sent.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('<context_update>') });
  });

});
