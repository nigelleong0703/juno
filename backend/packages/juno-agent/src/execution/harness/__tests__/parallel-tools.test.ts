/**
 * Codex-style parallel tool runtime: consecutive read-only calls from one response run concurrently,
 * while the durable journal and the transcript stay in call order, so a replay is identical.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Store, Tool, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { executeParallelToolCalls, supportsParallel } from '../services/run-tools.js';
import { readTranscript } from '../../brain/transcript.js';
import type { ToolCallContext } from '../services/tool-policy.js';
import { ScriptedModel } from '../testing/stubs.js';
import type { RunInput, RunServices } from '../services/run-types.js';

const OWNER = 'owner-1';
const AGENT = 'agent-1';
const CONV = 'conv-1';
const AT = '2026-10-12T00:00:00.000Z';
const wake: WakeEvent = {
  id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'go' }, at: AT, status: 'accepted',
};
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };

/** A journaling context that records the order in which durable entries are CREATED. */
function journaling(journal = new Map<string, unknown>()) {
  const created: string[] = [];
  let next = 0;
  const ctx: ToolCallContext = {
    rand: { uuidv4: () => 'u' + String(next++) },
    run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
      created.push(name);
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
    },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
  return { ctx, created, journal };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function reader(name: string, ms: number, runs: string[]): Tool {
  return {
    name, description: name, parameters: {}, replay: 'safe', sideEffect: false,
    execute: async (): Promise<ToolResult> => { runs.push(name); await sleep(ms); return { content: [{ type: 'text', text: name + ' result' }] }; },
  };
}
function registryOf(tools: Tool[]): ToolRegistry {
  return { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
}
async function seedRun(store: Store): Promise<void> {
  await store.put('runs', {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  }, { conversationId: CONV });
}

describe('parallel read-only tool calls', () => {
  it('runs consecutive read-only calls concurrently and keeps journal and transcript in call order', async () => {
    const store = createMemoryStore();
    await seedRun(store);
    const runs: string[] = [];
    // The first call is the SLOWER one, so completion order differs from call order.
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registryOf([reader('slow_read', 250, runs), reader('fast_read', 50, runs)]) };
    const { ctx, created, journal } = journaling();
    const calls = [{ toolIdx: 0, call: { id: 'c1', name: 'slow_read', arguments: {} } }, { toolIdx: 1, call: { id: 'c2', name: 'fast_read', arguments: {} } }];

    const started = Date.now();
    const results = await executeParallelToolCalls(ctx, services, input, 'run-1', 0, calls);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(250 + 50 + 30); // concurrent, not 300ms+ sequential
    expect(results.map((r) => (r === Symbol.for('x') ? '' : (r as { result: ToolResult }).result.content[0]))).toEqual([
      { type: 'text', text: 'slow_read result' }, { type: 'text', text: 'fast_read result' },
    ]);
    const effects = created.filter((name) => name.startsWith('tool:'));
    expect(effects).toEqual(['tool:stp_u0', 'tool:stp_u1']);
    const writes = created.filter((name) => name.startsWith('tool-result:'));
    expect(writes).toEqual(['tool-result:stp_u0', 'tool-result:stp_u1']);
    const transcript = (await readTranscript(store, input.sessionKey)).map((entry) => (entry.message as { toolCallId?: string }).toolCallId);
    expect(transcript).toEqual(['c1', 'c2']);

    // Replay: same journal, same creation order, no effect runs again.
    const replay = journaling(journal);
    const before = runs.length;
    await executeParallelToolCalls(replay.ctx, services, input, 'run-1', 0, calls);
    expect(runs.length).toBe(before);
    expect(replay.created).toEqual(created);
  });

  it('only read-only, non-background tools support parallel', () => {
    const writer: Tool = { name: 'send', description: 'send', parameters: {}, replay: 'never', sideEffect: true, execute: async () => ({ content: [] }) };
    const services: RunServices = { store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registryOf([reader('r', 1, []), writer]) };
    expect(supportsParallel(services, { id: 'a', name: 'r', arguments: {} })).toBe(true);
    expect(supportsParallel(services, { id: 'b', name: 'send', arguments: {} })).toBe(false);
    expect(supportsParallel(services, { id: 'c', name: 'missing', arguments: {} })).toBe(false);
  });
});
