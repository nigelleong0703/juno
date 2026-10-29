/**
 * Connector (MCP) tools classified `read` are read-only tools to the harness: consecutive ones from one reply run concurrently
 * (executeParallelToolCalls). A tool classified as a change, or unmarked, still runs alone and in order.
 */
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import type { Store, Tool, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import { createMcpTool } from '../../../modules/mcp/registry.js';
import { classifyTool } from '../../../modules/mcp/tool-access.js';
import type { McpManager } from '../../../modules/mcp/manager.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { executeParallelToolCalls, supportsParallel } from '../services/run-tools.js';
import type { RunInput, RunServices } from '../services/run-types.js';
import type { ToolCallContext } from '../services/tool-policy.js';
import { ScriptedModel } from '../testing/stubs.js';

const OWNER = 'owner-mcp';
const AGENT = 'agent-mcp';
const CONV = 'conv-mcp';
const AT = '2026-10-26T00:00:00.000Z';
const wake: WakeEvent = {
  id: 'wake-mcp', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'go' }, at: AT, status: 'accepted',
};
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };

function journaling(): ToolCallContext {
  let next = 0;
  const journal = new Map<string, unknown>();
  return {
    rand: { uuidv4: () => 'm' + String(next++) },
    run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
    },
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

/** A manager whose calls stay open until `release()`, so the test can see how many were started at once. */
function gatedManager() {
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = {
    async callTool(call: { toolName: string }) {
      started.push(call.toolName);
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return { parts: [{ type: 'text', text: call.toolName + ' done' }], text: call.toolName + ' done', truncated: false, unsupported: [], isError: false };
    },
  } as unknown as McpManager;
  return { manager, started, release: () => release(), peak: () => peak };
}

function connectorTool(manager: McpManager, name: string, annotations?: { readOnlyHint?: boolean }): Tool {
  const tool = { name, description: name, inputSchema: { type: 'object', properties: {} }, ...(annotations === undefined ? {} : { annotations }) };
  return createMcpTool({
    ownerId: OWNER, agentId: AGENT, connectionId: 'con-1', connectionName: 'Calendar', tool, catalogTruncated: false, manager,
    access: classifyTool(tool), name: 'calendar__' + name,
  });
}

function servicesOf(store: Store, tools: Tool[]): RunServices {
  const toolRegistry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry };
}

async function seedRun(store: Store): Promise<void> {
  // The owner's agent and direct chat: connected-app tools are offered where the owner is alone with the agent.
  await (store.forOwner?.(OWNER) ?? store).put('agents', { id: AGENT, ownerId: OWNER, name: 'Mcp' } as never);
  await (store.forOwner?.(OWNER) ?? store).put('conversations', { id: CONV, kind: 'direct', memberIds: [OWNER], agentIds: [AGENT] } as never);
  await store.put('runs', {
    id: 'run-mcp', agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  }, { conversationId: CONV });
}

const waitUntil = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('connector reads run in parallel', () => {
  it('registers a tool by its class: a read is a safe, side-effect-free tool; a change or an unmarked tool is not', () => {
    const { manager } = gatedManager();
    const read = connectorTool(manager, 'list_events', { readOnlyHint: true });
    const change = connectorTool(manager, 'create_event', { readOnlyHint: false });
    const unmarked = connectorTool(manager, 'mystery');
    expect([read.sideEffect, read.replay]).toEqual([false, 'safe']);
    expect([change.sideEffect, change.replay]).toEqual([true, 'never']);
    expect([unmarked.sideEffect, unmarked.replay]).toEqual([true, 'never']);
    const services = servicesOf(createMemoryStore(), [read, change, unmarked]);
    expect(supportsParallel(services, { id: 'a', name: read.name, arguments: {} })).toBe(true);
    expect(supportsParallel(services, { id: 'b', name: change.name, arguments: {} })).toBe(false);
    expect(supportsParallel(services, { id: 'c', name: unmarked.name, arguments: {} })).toBe(false);
  });

  it('starts two read calls of one reply before either has answered, and answers them in call order', async () => {
    const store = createMemoryStore();
    await seedRun(store);
    const { manager, started, release, peak } = gatedManager();
    const tools = [connectorTool(manager, 'list_events', { readOnlyHint: true }), connectorTool(manager, 'search_mail', { readOnlyHint: true })];
    const running = executeParallelToolCalls(journaling(), servicesOf(store, tools), input, 'run-mcp', 0, [
      { toolIdx: 0, call: { id: 'c1', name: tools[0]!.name, arguments: {} } },
      { toolIdx: 1, call: { id: 'c2', name: tools[1]!.name, arguments: {} } },
    ]);
    await waitUntil(() => started.length === 2);
    // Both are in flight and neither has resolved.
    expect(started).toEqual(['list_events', 'search_mail']);
    expect(peak()).toBe(2);
    release();
    const results = await running;
    expect(results.map((result) => (typeof result === 'symbol' ? '' : (result.result.content[0] as { text: string }).text))).toEqual(['list_events done', 'search_mail done']);
  });
});
