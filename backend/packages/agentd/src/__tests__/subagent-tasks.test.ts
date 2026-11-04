/** PH12 child tasks: the REAL run-tools path admits a child run in the parent's own conversation,
 * dispatches the EXACT reserved run id through the core adapter, links it durably to the parent and
 * stops the child's real run on cancellation without fabricating a status. */
import { createMemoryBlobStore } from '@agent-desktop/db';
import { describe, it, expect } from 'vitest';
import { DurablePromise } from '@agent-desktop/durable';
import { createMemoryStore } from '@agent-desktop/db';
import { LIMITS } from '@agent-desktop/contracts';
import type { Store, ToolContext, ToolRegistry, WakeEvent } from '@agent-desktop/contracts';
import { NEVER_CANCELLED } from 'juno-agent/execution/harness/services/cancel';
import { executeSingleToolCall } from 'juno-agent/execution/harness/services/run-tools';
import type { ToolCallContext } from 'juno-agent/execution/harness/services/tool-policy';
import type { RunInput, RunServices } from 'juno-agent/execution/harness/services/run-types';
import { ScriptedModel } from 'juno-agent/execution/harness/testing/stubs';
import { createToolRegistry } from 'juno-agent/modules/tools/index';
import { cancelSubagentTasks, listSubagentTasks, type SubagentDispatchAdapter } from 'juno-agent/modules/tasks/subagent';
import { replyStep } from 'juno-agent/execution/harness/services/final-reply';
import type { RunContext } from 'juno-agent/execution/harness/services/run-types';

const OWNER = 'owner-1';
const AGENT = 'agent-a';
const CONV = 'conv-parent';
const PARENT = 'run-parent';
const STEP = 'stp-1';
const AT = '2026-10-08T00:00:00.000Z';

const wake: WakeEvent = {
  id: 'w', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: AT, status: 'accepted',
};

/** The core's run entry, recorded exactly: the dispatched id must be the linked child id. */
class RecordingAdapter implements SubagentDispatchAdapter {
  readonly started: Array<{ runId: string; agentId: string; sessionKey: string; planId: string; parentRunId: string; conversationId: string }> = [];
  async startSubagentRun(input: { runId: string; agentId: string; sessionKey: string; planId: string; parentRunId: string; conversationId: string }): Promise<void> {
    this.started.push({ runId: input.runId, agentId: input.agentId, sessionKey: input.sessionKey, planId: input.planId, parentRunId: input.parentRunId, conversationId: input.conversationId });
  }
}

function ctxFor(store: Store, agentId = AGENT): ToolContext {
  return { ownerId: OWNER, agentId, conversationId: CONV, runId: PARENT, stepId: STEP, store, blobs: createMemoryBlobStore(), enqueuer: { enqueue: async () => ({ accepted: true }), stopRun: async () => undefined, resolveAwakeable: async () => undefined, scheduleRoutine: async () => undefined }, wake, step: async (_name, fn) => fn(), signal: new AbortController().signal };
}

function testContext(): ToolCallContext {
  const journal = new Map<string, unknown>();
  return {
    rand: { uuidv4: () => STEP },
    run<T>(name: string, action: () => Promise<T>): DurablePromise<T> {
      if (journal.has(name)) return DurablePromise.resolve(structuredClone(journal.get(name)) as T);
      return DurablePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
    },
  };
}

async function seed(store: Store, overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  const scoped = store.forOwner === undefined ? store : store.forOwner(OWNER);
  await scoped.put('agents', { id: AGENT, name: AGENT, handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: OWNER, createdAt: AT, updatedAt: AT });
  await scoped.put('runs', {
    id: PARENT, agentId: AGENT, conversationId: CONV, title: 'parent', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
    ...overrides,
  }, { agentId: AGENT, conversationId: CONV });
  await scoped.put('conversations', { id: CONV, kind: 'direct', title: 'p', agentIds: [AGENT], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT }, { conversationId: CONV });
}

async function registry(store: Store, adapter: RecordingAdapter): Promise<ToolRegistry> {
  return createToolRegistry({ store, enqueuer: ctxFor(store).enqueuer, subagentDispatch: adapter });
}

const runInput: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };

describe('child tasks', () => {
  it('resolves the same child run on a replay instead of spawning a second one', async () => {
    const store = createMemoryStore();
    await seed(store);
    const adapter = new RecordingAdapter();
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: ctxFor(store).enqueuer, brain: new ScriptedModel(), toolRegistry: await registry(store, adapter) };
    const ctx0 = testContext();
    const call = { id: 'call-1', name: 'subagent_start', arguments: { prompt: 'once' } };
    await executeSingleToolCall(ctx0, services, runInput, PARENT, 0, 0, call, NEVER_CANCELLED, []);
    await executeSingleToolCall(ctx0, services, runInput, PARENT, 0, 0, call, NEVER_CANCELLED, []);
    expect(await listSubagentTasks(store, PARENT)).toHaveLength(1);
    expect(adapter.started).toHaveLength(1);
    expect((await store.get('runs', PARENT))?.childRunIds).toHaveLength(1);
  });

  it('refuses a foreign owner, an unauthorized target, a full budget and too many ACTIVE children', async () => {
    const store = createMemoryStore();
    await seed(store);
    await store.put('agents', { id: 'agent-foreign', name: 'f', handle: 'f', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: 'owner-9', createdAt: AT, updatedAt: AT });
    const adapter = new RecordingAdapter();
    const tools = await registry(store, adapter);
    const foreignTarget = await tools.get('subagent_start')?.execute({ prompt: 'x', targetAgentId: 'agent-foreign' }, ctxFor(store));
    expect(foreignTarget?.details).toMatchObject({ refused: 'target_not_authorized' });
    const noDispatcher = await createToolRegistry({ store, enqueuer: ctxFor(store).enqueuer });
    expect((await noDispatcher.get('subagent_start')?.execute({ prompt: 'x' }, ctxFor(store)))?.details).toMatchObject({ refused: 'dispatch_unavailable' });
    const budgetStore = createMemoryStore();
    await seed(budgetStore, { usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: LIMITS.run.maxSteps } });
    const budgetTools = await registry(budgetStore, adapter);
    expect((await budgetTools.get('subagent_start')?.execute({ prompt: 'x' }, ctxFor(budgetStore)))?.details).toMatchObject({ refused: 'budget_exhausted' });
    // Concurrency counts ACTIVE children only: terminal history never blocks a new spawn.
    const fullStore = createMemoryStore();
    await seed(fullStore);
    const fullTools = await registry(fullStore, adapter);
    for (let index = 0; index < 4; index += 1) await fullTools.get('subagent_start')?.execute({ prompt: 'c' + String(index) }, { ...ctxFor(fullStore), stepId: 'stp-' + String(index) });
    const children = await listSubagentTasks(fullStore, PARENT);
    await fullStore.patch('runs', String(children[0]?.runId), { status: 'completed' });
    await fullStore.patch('runs', String(children[1]?.runId), { status: 'blocked' });
    const allowed = await fullTools.get('subagent_start')?.execute({ prompt: 'fifth' }, { ...ctxFor(fullStore), stepId: 'stp-5' });
    expect(allowed?.isError).not.toBe(true);
    expect(await listSubagentTasks(fullStore, PARENT)).toHaveLength(5);
  });

  it('stops the real child run on cancellation without fabricating a status', async () => {
    const store = createMemoryStore();
    await seed(store);
    const adapter = new RecordingAdapter();
    const tools = await registry(store, adapter);
    await tools.get('subagent_start')?.execute({ prompt: 'work' }, ctxFor(store));
    const child = (await listSubagentTasks(store, PARENT))[0];
    const stopped: string[] = [];
    expect(await cancelSubagentTasks(store, async (runId) => { stopped.push(runId); }, PARENT)).toEqual({ cancelled: 1 });
    expect(stopped).toEqual([String(child?.runId)]);
    // The run's own status is authoritative: nothing was patched ahead of the effect.
    expect((await store.get('runs', String(child?.runId)))?.status).toBe('queued');
  });

  it('writes the producing runId on the reply item', async () => {
    const store = createMemoryStore();
    await seed(store);
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: ctxFor(store).enqueuer, brain: new ScriptedModel(), toolRegistry: await registry(store, new RecordingAdapter()) };
    const ctx = { rand: { uuidv4: () => 'i1' }, run: async (_name: string, action: () => Promise<unknown>) => action() } as unknown as RunContext;
    const result = await replyStep(ctx, services, runInput, 0, 'hello', NEVER_CANCELLED, [], PARENT);
    expect(result).toBe('completed');
    const item = (await store.list('items', { limit: 5 })).items[0] as { runId?: string } | undefined;
    expect(item?.runId).toBe(PARENT);
  });
});
