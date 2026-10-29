/**
 * What a run records about its tool calls: the real tool name, why a failed one failed (`errorKind`), which call was a retry of
 * which (`retryOf`), and for a discovery step the query and the tool called after it. Also the argument boundary the calls go through:
 * an optional string the model left empty is left out and logged, a required one is not, and an invalid call gets the teaching error.
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

const AT = '2026-10-24T00:00:00.000Z';
const AGENT = 'agent-steps';
const CONV = 'conv-steps';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const wake: WakeEvent = {
  id: 'wake-1', ownerId: 'owner-steps', agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV, kind: 'user_message',
  origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'find the wifi password', addressed: 'direct' }, at: AT, status: 'accepted',
};
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };
const run: Run = {
  id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat',
  steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
};

const turn = (...calls: AssistantTurn['toolCalls']): AssistantTurn => ({ text: '', toolCalls: calls, usage, stopReason: 'tool_calls' });
const final: AssistantTurn = { text: 'It is hunter2.', toolCalls: [], usage, stopReason: 'stop' };

function brainOf(turns: AssistantTurn[]): Brain {
  let index = 0;
  return {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: input.sessionKey, agentId: AGENT, modelSelection: { modelId: 'model-under-test', baseUrl: 'https://x/v1', supportsImages: false } };
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
  let ids = 0;
  return {
    rand: { uuidv4: () => 'id-' + String(ids++) },
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

/** A built-in (not connected-app) tool: `q` is required, `folder` optional. A call with q "boom" fails after validation. */
const notes: Tool = {
  name: 'search_notes', description: 'Search saved notes by words.', replay: 'safe', sideEffect: false,
  parameters: { type: 'object', properties: { q: { type: 'string' }, folder: { type: ['string', 'null'] } }, required: ['q'], additionalProperties: false },
  async execute(args) {
    const received = args as Record<string, unknown>;
    return received['q'] === 'boom'
      ? { content: [{ type: 'text', text: 'the notes service is down' }], isError: true }
      : { content: [{ type: 'text', text: 'Wifi password: hunter2' }] };
  },
};

async function drive(turns: AssistantTurn[]) {
  const store = createMemoryStore();
  await store.put('runs', run, { conversationId: CONV });
  const received: Array<Record<string, unknown>> = [];
  const logs: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const recording: Tool = { ...notes, async execute(args, ctx) { received.push(args as Record<string, unknown>); return notes.execute(args, ctx); } };
  const search = createToolSearchTool({ all: async () => [recording], visible: async () => new Set(['tool_search']) });
  const tools = [search, recording];
  const registry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
  const brain = brainOf(turns);
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry, log: (fields, message) => logs.push({ fields, message }) };
  await runLoop(context(), services, { ...input }, 'run-1', await brain.buildContext({ agentId: AGENT, conversationId: CONV, sessionKey: input.sessionKey, wake: [wake] }), NEVER_CANCELLED);
  const steps = (await store.list('steps', { limit: 20 })).items.sort((a, b) => a.index - b.index);
  const rows = (await store.list('transcripts', { limit: 50 })).items.slice().sort((a, b) => a.seq - b.seq).map((row) => row.message);
  const events = (await store.eventBus.since(0, 500)).map((row) => row.event);
  return { steps, rows, received, logs, events };
}

describe('tool steps of a run', () => {
  it('streams a standard tool-call segment with the stable step id and a parseable arguments document', async () => {
    const { steps, events } = await drive([
      turn({ id: 'call_1', name: 'search_notes', arguments: { q: 'wifi' } }),
      final,
    ]);
    const stepId = steps[0]?.id;
    if (stepId === undefined) throw new Error('missing step');
    const typeAt = (type: string) => events.findIndex((event) => event.type === type && 'toolCallId' in event && event.toolCallId === stepId);
    const start = events.find((event) => event.type === 'TOOL_CALL_START' && event.toolCallId === stepId);
    const args = events.find((event) => event.type === 'TOOL_CALL_ARGS' && event.toolCallId === stepId);
    const end = events.find((event) => event.type === 'TOOL_CALL_END' && event.toolCallId === stepId);
    const result = events.find((event) => event.type === 'TOOL_CALL_RESULT' && event.toolCallId === stepId);
    expect(start).toMatchObject({ toolCallName: 'search_notes', metadata: { juno: { runId: 'run-1', conversationId: CONV, stepId } } });
    expect(args?.type === 'TOOL_CALL_ARGS' ? JSON.parse(args.delta) : undefined).toEqual({ q: 'wifi' });
    expect(result).toMatchObject({ messageId: 'toolresult_' + stepId, role: 'tool' });
    // The wire result is the bounded, redacted projection; the model's own transcript keeps the raw text.
    const wireResult = result?.type === 'TOOL_CALL_RESULT' ? result.content : '';
    expect(wireResult).toContain('Wifi password:');
    expect(wireResult).not.toContain('hunter2');
    expect(typeAt('TOOL_CALL_START')).toBeLessThan(typeAt('TOOL_CALL_ARGS'));
    expect(typeAt('TOOL_CALL_ARGS')).toBeLessThan(typeAt('TOOL_CALL_END'));
    expect(typeAt('TOOL_CALL_END')).toBeLessThan(typeAt('TOOL_CALL_RESULT'));
  });

  it('records the real tool name and links a search to the tool called after it', async () => {
    const { steps } = await drive([
      turn({ id: 'call_1', name: 'tool_search', arguments: { query: 'search saved notes' } }),
      turn({ id: 'call_2', name: 'search_notes', arguments: { q: 'wifi' } }),
      final,
    ]);
    expect(steps.map((step) => step.tool)).toEqual(['tool_search', 'search_notes']);
    expect(steps[0]).toMatchObject({ kind: 'mcp', searchQuery: 'search saved notes', calledTool: 'search_notes', status: 'completed' });
    expect(steps[1]?.calledTool).toBeUndefined();
    // Looking a tool up is plumbing; the notes search is work the person should see.
    expect(steps.map((step) => step.internal)).toEqual([true, undefined]);
  });

  it('marks a call that does not fit the schema as a failed validation, with the teaching error, and the next call to the tool as its retry', async () => {
    const { steps, rows } = await drive([
      turn({ id: 'call_1', name: 'search_notes', arguments: { folder: 'work' } }),
      turn({ id: 'call_2', name: 'search_notes', arguments: { q: 'boom' } }),
      turn({ id: 'call_3', name: 'search_notes', arguments: { q: 'wifi' } }),
      final,
    ]);
    expect(steps.map((step) => [step.status, step.errorKind])).toEqual([['failed', 'validation'], ['failed', 'other'], ['completed', undefined]]);
    expect(steps[0]?.retryOf).toBeUndefined();
    expect(steps[1]?.retryOf).toBe(steps[0]?.id);
    expect(steps[2]?.retryOf).toBe(steps[1]?.id);
    const first = JSON.stringify(rows.find((row) => row['role'] === 'toolResult' && row['toolCallId'] === 'call_1'));
    expect(first).toContain('invalid search_notes arguments');
    expect(first).toContain('q: received nothing (the field is missing)');
    expect(first).toContain('Corrected example: {\\"q\\":\\"<q>\\"');
  });

  it('leaves out an optional string the model left empty and logs it, but keeps a required one and answers it', async () => {
    const { received, logs, steps } = await drive([
      turn({ id: 'call_1', name: 'search_notes', arguments: { q: 'wifi', folder: '' } }),
      turn({ id: 'call_2', name: 'search_notes', arguments: { q: '' } }),
      final,
    ]);
    expect(received).toEqual([{ q: 'wifi' }, { q: '' }]);
    const normalized = logs.filter((entry) => entry.message === 'tool argument normalized');
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.fields).toMatchObject({ tool: 'search_notes', field: 'folder', was: 'empty', model: 'model-under-test' });
    expect(steps.map((step) => step.tool)).toEqual(['search_notes', 'search_notes']);
  });
});
