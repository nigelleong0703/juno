import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createEngineRegistry, type EngineAdapter, type EngineTurnContext } from '../engines/registry.js';
import { resolveRunEngine } from '../engines/selection.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { ScriptedModel, FakeToolRegistry } from '../testing/stubs.js';
import type { WakeEvent } from '../../../contracts/index.js';
import { RestatePromise } from '@agent-desktop/durable';

const at = new Date().toISOString();

function scriptedAdapter(id: string, calls: string[]): EngineAdapter {
  return {
    id,
    name: id,
    version: '9',
    available: true,
    capabilities: { tools: true, approvals: true, steering: true, deltas: false },
    executeTurn: async (_context: EngineTurnContext) => {
      calls.push(id);
      return 'completed';
    },
  };
}

function turnContext() {
  const store = createMemoryStore();
  const brain = new ScriptedModel();
  const tools = new FakeToolRegistry();
  const wake: WakeEvent = {
    id: 'wake-1',
    ownerId: 'owner',
    agentId: 'agent-1',
    sessionKey: 'agent-1:conv-1',
    conversationId: 'conv-1',
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: { text: 'hi' },
    at,
    status: 'accepted',
  };
  const ctx = {
    rand: { uuidv4: () => 'id-1' },
    run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({
      id: 'awake',
      promise: RestatePromise.resolve(new Promise<T>(() => {})),
    }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
  return {
    ctx,
    services: { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: tools },
    input: { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake] },
    runId: 'run-1',
    brainCtx: { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' },
    cancellation: NEVER_CANCELLED,
  };
}

describe('selectable engines', () => {
  it('routes two injected adapters to different executions', async () => {
    const calls: string[] = [];
    const registry = createEngineRegistry([scriptedAdapter('alpha', calls), scriptedAdapter('beta', calls)]);
    const alpha = registry.resolve('alpha');
    const beta = registry.resolve('beta');
    const base = turnContext();
    await alpha.executeTurn({ ...base });
    await beta.executeTurn({ ...base });
    expect(calls).toEqual(['alpha', 'beta']);
  });

  it('rejects unknown and unavailable engines without fallback', () => {
    const calls: string[] = [];
    const registry = createEngineRegistry([scriptedAdapter('alpha', calls), { ...scriptedAdapter('gamma', calls), available: false, reason: 'engine not configured' }]);
    expect(() => registry.resolve('missing')).toThrow(/unknown/i);
    expect(() => registry.resolve('gamma')).toThrow(/unavailable/i);
    expect(calls).toEqual([]);
  });

  it('refuses a registry without an available pi engine instead of falling back', () => {
    const calls: string[] = [];
    const registry = createEngineRegistry([scriptedAdapter('alpha', calls)]);
    expect(() => resolveRunEngine(registry)).toThrow(/unknown engine/i);
    expect(calls).toEqual([]);
  });
});
