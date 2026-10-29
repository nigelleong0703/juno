/**
 * A hidden tool through the run loop. On a model with native deferred loading the model searches (`tool_search` answers with the names it
 * loaded) and then calls the hidden tool by its own name; on a proxy model the reply was already unwrapped from `tool_call` where it was
 * received. Either way the tool runs once with its own arguments, under its own name in the step row, and the transcript keeps what
 * the provider needs to replay the exchange.
 */
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, Tool, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { createToolSearchTool } from '../../../modules/tools/tools/toolSearch.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const AT = '2026-10-22T00:00:00.000Z';
const AGENT = 'agent-hidden';
const CONV = 'conv-hidden';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const wake: WakeEvent = {
  id: 'wake-1', ownerId: 'owner-hidden', agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV, kind: 'user_message',
  origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'find the wifi password', addressed: 'direct' }, at: AT, status: 'accepted',
};
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };
const run: Run = {
  id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat',
  steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
};

const turn = (...calls: AssistantTurn['toolCalls']): AssistantTurn => ({ text: '', toolCalls: calls, usage, stopReason: 'tool_calls' });
const final: AssistantTurn = { text: 'It is hunter2.', toolCalls: [], usage, stopReason: 'stop' };

function brainOf(turns: AssistantTurn[], toolSearch?: 'responses-tool-search'): Brain {
  let index = 0;
  return {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: input.sessionKey, agentId: AGENT, modelSelection: { modelId: 'm', baseUrl: 'https://x/v1', supportsImages: false, ...(toolSearch === undefined ? {} : { toolSearch }) } };
    },
    async step(): Promise<AssistantTurn> {
      const next = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (next === undefined) throw new Error('no scripted turn');
      return next;
    },
    shouldCompact: () => false,
    async compact(ctx) {
      return ctx;
    },
  };
}

function context(): RunContext {
  const journal = new Map<string, unknown>();
  return {
    rand: { uuidv4: () => 'id-' + String(journal.size) },
    run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
      return RestatePromise.resolve(action().then((value) => {
        journal.set(name, value);
        return value;
      }));
    },
    awakeable<T>(): { id: string; promise: RestatePromise<T> } {
      return { id: 'awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) };
    },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

async function drive(turns: AssistantTurn[], toolSearch?: 'responses-tool-search') {
  const store = createMemoryStore();
  // The owner's agent and direct chat: who is present is read from them (batch 5b), and the owner alone is the default.
  await store.put('agents', { id: AGENT, ownerId: 'owner-hidden', name: 'Nova' } as never);
  await store.put('conversations', { id: CONV, kind: 'direct', memberIds: ['owner-hidden'], agentIds: [AGENT] } as never);
  await store.put('runs', run, { conversationId: CONV });
  const received: Array<Record<string, unknown>> = [];
  const hidden: Tool = {
    name: 'search_notes', description: 'Search saved notes by words.', mcp: true, replay: 'safe', sideEffect: false,
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    async execute(args) {
      received.push(args as Record<string, unknown>);
      return { content: [{ type: 'text', text: 'Wifi password: hunter2' }] };
    },
  };
  const shown = new Set(['tool_search']);
  const search = createToolSearchTool({ all: async () => [hidden], visible: async () => shown });
  const tools = [search, hidden];
  const registry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
  const brain = brainOf(turns, toolSearch);
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry };
  const outcome = await runLoop(context(), services, { ...input }, 'run-1', await brain.buildContext({ agentId: AGENT, conversationId: CONV, sessionKey: input.sessionKey, wake: [wake] }), NEVER_CANCELLED);
  const rows = (await store.list('transcripts', { limit: 50 })).items.slice().sort((a, b) => a.seq - b.seq).map((row) => row.message);
  const steps = (await store.list('steps', { limit: 10 })).items.sort((a, b) => a.index - b.index).map((step) => step.target);
  return { outcome, received, rows, steps };
}

describe('a hidden tool in the run loop', () => {
  it('native: the search loads the tool by name, the model then calls it directly with its own arguments', async () => {
    const { outcome, received, rows, steps } = await drive([
      turn({ id: 'call_ts1', name: 'tool_search', arguments: { query: 'search saved notes' } }),
      turn({ id: 'call_2', name: 'search_notes', arguments: { q: 'wifi' } }),
      final,
    ], 'responses-tool-search');
    expect(outcome).toBe('completed');
    expect(received).toEqual([{ q: 'wifi' }]);
    expect(steps).toEqual(['tool_search', 'search_notes']);
    const searchResult = rows.find((row) => row['role'] === 'toolResult' && row['toolCallId'] === 'call_ts1');
    expect(searchResult).toMatchObject({ toolName: 'tool_search', loadedTools: ['search_notes'] });
    expect(JSON.stringify(searchResult)).toContain('Loaded 1 tool');
    expect(JSON.stringify(searchResult)).not.toContain('tool_call');
  });

  it('proxy: a call unwrapped from tool_call runs as the tool it reaches and is stored under the name the model called', async () => {
    const { outcome, received, rows, steps } = await drive([
      turn({ id: 'call_p1', name: 'search_notes', arguments: { q: 'wifi' }, wireName: 'tool_call' }),
      final,
    ]);
    expect(outcome).toBe('completed');
    expect(received).toEqual([{ q: 'wifi' }]);
    expect(steps).toEqual(['search_notes']);
    expect(rows.find((row) => row['role'] === 'toolResult')).toMatchObject({ toolCallId: 'call_p1', toolName: 'tool_call' });
  });
});
