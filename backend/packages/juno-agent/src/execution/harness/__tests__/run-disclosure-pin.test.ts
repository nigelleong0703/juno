import { describe, expect, it, vi } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import type { Brain, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { requestScopedStore } from '../../../owner-context.js';
import { agentDoc, conversationDoc } from '../../../execution/brain/__tests__/agent-resources.fixtures.js';
import { runWorkflowBody, type RunBodyContext } from '../services/run.js';
import { createEngineRegistry } from '../engines/registry.js';

describe('first model discovery preparation pin', () => {
  it('delivers a journaled preparation note before the engine sees its first model context', async () => {
    const raw = createMemoryStore();
    const forOwner = raw.forOwner;
    if (!forOwner) throw new Error('owner-scoped store is required');
    const owner = forOwner('owner-1');
    await owner.put('agents', agentDoc('agent-1', []));
    await owner.put('conversations', conversationDoc('conv-1', ['agent-1']));
    const store = requestScopedStore(raw);
    const prepare = vi.fn(async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'PREPARED-TOOL-DEFINITION' }] }));
    let observed = '';
    const brain: Brain = {
      buildContext: async () => {
        observed = JSON.stringify((await store.list('transcripts', { limit: 100 })).items);
        return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' };
      },
      step: async () => ({ text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, stopReason: 'stop' }),
      shouldCompact: () => false, compact: async (context) => context,
    };
    const wake: WakeEvent = {
      id: 'wake-1', ownerId: 'owner-1', agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1',
      kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'Search Notion for the launch notes' },
      at: new Date().toISOString(), status: 'accepted',
    };
    const ctx: RunBodyContext = {
      key: 'run-disclosure', rand: { uuidv4: () => 'deterministic-id' },
      run: (_name, action) => RestatePromise.resolve(action()),
      awakeable: <T>() => ({ id: 'awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
      cancel: { peek: async () => false, get: () => RestatePromise.resolve(new Promise<boolean>(() => {})) },
      runFinished: async () => {},
    };
    const registry = { forAgent: async () => [], get: () => undefined, prepareForModel: prepare };
    await runWorkflowBody(ctx, {
      store, brain, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), toolRegistry: registry,
      engines: createEngineRegistry([{ id: 'pi', name: 'pin', version: '1', available: true,
        capabilities: { tools: true, approvals: true, steering: true, deltas: false }, executeTurn: async () => 'completed' }]),
    }, { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake] });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(observed).toContain('PREPARED-TOOL-DEFINITION');
  });
});
