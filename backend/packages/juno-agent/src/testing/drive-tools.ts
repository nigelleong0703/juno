/**
 * Test helper: one chat run through the production run loop with scripted model turns and the tools a test hands in, over the in-memory
 * store. The owner is the one waiting (a user-origin wake), so the final text is delivered like any chat reply.
 */
import { DurablePromise } from '@agent-desktop/durable';
import type { Run } from '@agent-desktop/public-contracts';
import { createMemoryBlobStore } from './blobs.js';
import { createMemoryStore, NoopEnqueuer } from './store.js';
import type { AssistantTurn, Brain, BrainContext, Tool, ToolRegistry, WakeEvent } from '../contracts/index.js';
import { NEVER_CANCELLED } from '../execution/harness/services/cancel.js';
import { runLoop } from '../execution/harness/services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../execution/harness/services/run-types.js';

export const AT = '2026-11-01T08:00:00.000Z';
export const AGENT = 'agent-drive';
export const CONV = 'conv-drive';
export const OWNER = 'owner-drive';
export const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

export const userWake: WakeEvent = {
  id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV, kind: 'user_message',
  origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'please do it' }, at: AT, status: 'accepted',
};

export const call = (id: string, name: string, args: Record<string, unknown>): AssistantTurn['toolCalls'][number] => ({ id, name, arguments: args });
export const turn = (text: string, ...calls: AssistantTurn['toolCalls']): AssistantTurn => ({ text, toolCalls: calls, usage, stopReason: calls.length > 0 ? 'tool_calls' : 'stop' });

/** `tools` may be built from the run's store (a tool that writes to it). */
export async function driveTools(turns: AssistantTurn[], toolsOrFactory: Tool[] | ((store: ReturnType<typeof createMemoryStore>) => Tool[])) {
  const store = createMemoryStore();
  const tools = typeof toolsOrFactory === 'function' ? toolsOrFactory(store) : toolsOrFactory;
  const row: Run = {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'Do it', status: 'running', kind: 'chat', origin: { type: 'owner_message', conversationId: CONV },
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  };
  await store.put('agents', { id: AGENT, ownerId: OWNER, name: 'Nova' } as never);
  await store.put('conversations', { id: CONV, kind: 'direct', memberIds: [OWNER], agentIds: [AGENT], unreadCount: 0 } as never);
  await store.put('runs', row, { conversationId: CONV });
  let index = 0;
  const brain: Brain = {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: userWake.sessionKey, agentId: AGENT, modelSelection: { modelId: 'm', baseUrl: 'https://x/v1', supportsImages: false } };
    },
    async step(): Promise<AssistantTurn> {
      const next = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (next === undefined) throw new Error('no scripted turn');
      return next;
    },
    shouldCompact: () => false,
    async compact(ctx) { return ctx; },
  };
  const registry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry };
  const context: RunContext = {
    rand: { uuidv4: () => 'id-' + Math.random().toString(36).slice(2) },
    run: <T>(_name: string, action: () => Promise<T>): DurablePromise<T> => DurablePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: DurablePromise<T> } => ({ id: 'awake', promise: DurablePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => DurablePromise.resolve<WakeEvent[]>([]),
  };
  const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: userWake.sessionKey, wakeEvents: [userWake] };
  const outcome = await runLoop(context, services, input, 'run-1', await brain.buildContext({ agentId: AGENT, conversationId: CONV, sessionKey: userWake.sessionKey, wake: [userWake] }), NEVER_CANCELLED);
  const run = await store.get('runs', 'run-1');
  const items = (await store.list('items', { limit: 50 })).items;
  const requests = (await store.list('requests', { limit: 50 })).items;
  return { outcome, run, store, items, requests, steps: run?.steps ?? [], modelCalls: index };
}
