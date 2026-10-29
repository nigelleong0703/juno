/** PH12 child tasks: the REAL run-tools path admits a child run in the parent's own conversation,
 * dispatches the EXACT reserved run id through the core adapter, links it durably to the parent,
 * waits on its completion event (never a fake user request), aggregates the parent-visible result and
 * stops the child's real run on cancellation without fabricating a status. */
import { createMemoryBlobStore } from '@agent-desktop/db';
import { describe, it, expect } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore } from '@agent-desktop/db';
import { LIMITS } from '@agent-desktop/contracts';
import type { Store, ToolContext, ToolRegistry, WakeEvent } from '@agent-desktop/contracts';
import { NEVER_CANCELLED } from 'juno-agent/execution/harness/services/cancel';
import { executeSingleToolCall } from 'juno-agent/execution/harness/services/run-tools';
import type { ToolCallContext } from 'juno-agent/execution/harness/services/tool-policy';
import type { RunInput, RunServices } from 'juno-agent/execution/harness/services/run-types';
import { ScriptedModel } from 'juno-agent/execution/harness/testing/stubs';
import { createToolRegistry } from 'juno-agent/modules/tools/index';
import { cancelChildTasks, listChildTasks, type ChildDispatchAdapter } from 'juno-agent/modules/tasks/child';
import { awaitChildTasks } from 'juno-agent/modules/tasks/childWait';
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
class RecordingAdapter implements ChildDispatchAdapter {
  readonly started: Array<{ runId: string; agentId: string; sessionKey: string; planId: string; parentRunId: string; conversationId: string }> = [];
  async startChildRun(input: { runId: string; agentId: string; sessionKey: string; planId: string; parentRunId: string; conversationId: string }): Promise<void> {
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
    run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
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
  return createToolRegistry({ store, enqueuer: ctxFor(store).enqueuer, childDispatch: adapter });
}

const runInput: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };

describe('child tasks', () => {
  it('resolves the same child run on a replay instead of spawning a second one', async () => {
    const store = createMemoryStore();
    await seed(store);
    const adapter = new RecordingAdapter();
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: ctxFor(store).enqueuer, brain: new ScriptedModel(), toolRegistry: await registry(store, adapter) };
    const ctx0 = testContext();
    const call = { id: 'call-1', name: 'child_spawn', arguments: { prompt: 'once' } };
    await executeSingleToolCall(ctx0, services, runInput, PARENT, 0, 0, call, NEVER_CANCELLED, []);
    await executeSingleToolCall(ctx0, services, runInput, PARENT, 0, 0, call, NEVER_CANCELLED, []);
    expect(await listChildTasks(store, PARENT)).toHaveLength(1);
    expect(adapter.started).toHaveLength(1);
    expect((await store.get('runs', PARENT))?.childRunIds).toHaveLength(1);
  });

  it('refuses a foreign owner, an unauthorized target, a full budget and too many ACTIVE children', async () => {
    const store = createMemoryStore();
    await seed(store);
    await store.put('agents', { id: 'agent-foreign', name: 'f', handle: 'f', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: 'owner-9', createdAt: AT, updatedAt: AT });
    const adapter = new RecordingAdapter();
    const tools = await registry(store, adapter);
    const foreignTarget = await tools.get('child_spawn')?.execute({ prompt: 'x', targetAgentId: 'agent-foreign' }, ctxFor(store));
    expect(foreignTarget?.details).toMatchObject({ refused: 'target_not_authorized' });
    const noDispatcher = await createToolRegistry({ store, enqueuer: ctxFor(store).enqueuer });
    expect((await noDispatcher.get('child_spawn')?.execute({ prompt: 'x' }, ctxFor(store)))?.details).toMatchObject({ refused: 'dispatch_unavailable' });
    const budgetStore = createMemoryStore();
    await seed(budgetStore, { usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: LIMITS.run.maxSteps } });
    const budgetTools = await registry(budgetStore, adapter);
    expect((await budgetTools.get('child_spawn')?.execute({ prompt: 'x' }, ctxFor(budgetStore)))?.details).toMatchObject({ refused: 'budget_exhausted' });
    // Concurrency counts ACTIVE children only: terminal history never blocks a new spawn.
    const fullStore = createMemoryStore();
    await seed(fullStore);
    const fullTools = await registry(fullStore, adapter);
    for (let index = 0; index < 4; index += 1) await fullTools.get('child_spawn')?.execute({ prompt: 'c' + String(index) }, { ...ctxFor(fullStore), stepId: 'stp-' + String(index) });
    const children = await listChildTasks(fullStore, PARENT);
    await fullStore.patch('runs', String(children[0]?.runId), { status: 'completed' });
    await fullStore.patch('runs', String(children[1]?.runId), { status: 'blocked' });
    const allowed = await fullTools.get('child_spawn')?.execute({ prompt: 'fifth' }, { ...ctxFor(fullStore), stepId: 'stp-5' });
    expect(allowed?.isError).not.toBe(true);
    expect(await listChildTasks(fullStore, PARENT)).toHaveLength(5);
  });

  it('waits on the child completion event, exposes the parent-visible result and raises no user request', async () => {
    const store = createMemoryStore();
    await seed(store);
    const adapter = new RecordingAdapter();
    const tools = await registry(store, adapter);
    await tools.get('child_spawn')?.execute({ prompt: 'work' }, ctxFor(store));
    const waiting = await tools.get('child_wait')?.execute({}, ctxFor(store));
    expect(waiting?.suspend).toMatchObject({ reason: 'child' });
    expect(waiting?.suspend?.reason).not.toBe('user');
    expect((await store.list('requests', { limit: 5 })).items).toHaveLength(0);
    const child = (await listChildTasks(store, PARENT))[0];
    // CT: the parent-visible result is the canonical stored childResult on the child's own row;
    // a child never posts a chat bubble for it.
    await store.patch('runs', String(child?.runId), { status: 'completed', childResult: 'child done' });
    const done = await tools.get('child_wait')?.execute({}, ctxFor(store));
    expect(done?.suspend).toBeUndefined();
    const results = await tools.get('child_results')?.execute({}, ctxFor(store));
    expect(results?.details).toMatchObject({ active: 0 });
    expect(JSON.stringify(results?.content)).toContain('child done');
  });

  it('stops the real child run on cancellation without fabricating a status', async () => {
    const store = createMemoryStore();
    await seed(store);
    const adapter = new RecordingAdapter();
    const tools = await registry(store, adapter);
    await tools.get('child_spawn')?.execute({ prompt: 'work' }, ctxFor(store));
    const child = (await listChildTasks(store, PARENT))[0];
    const stopped: string[] = [];
    expect(await cancelChildTasks(store, async (runId) => { stopped.push(runId); }, PARENT)).toEqual({ cancelled: 1 });
    expect(stopped).toEqual([String(child?.runId)]);
    // The run's own status is authoritative: nothing was patched ahead of the effect.
    expect((await store.get('runs', String(child?.runId)))?.status).toBe('queued');
  });

  it('refuses reading a child that belongs to another parent', async () => {
    const store = createMemoryStore();
    await seed(store);
    const tools = await registry(store, new RecordingAdapter());
    await store.put('runs', { id: 'run-child-other', agentId: AGENT, conversationId: CONV, parentRunId: 'run-other-parent', title: 'x', status: 'queued', kind: 'background', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT }, { agentId: AGENT, conversationId: CONV });
    const refused = await tools.get('child_results')?.execute({ runId: 'run-child-other' }, ctxFor(store));
    expect(refused?.isError).toBe(true);
    expect(refused?.details).toMatchObject({ refused: 'not_own_child' });
  });

  it('suspends as an explicit child wait, never a user request', async () => {
    const store = createMemoryStore();
    await seed(store);
    const tools = await registry(store, new RecordingAdapter());
    await tools.get('child_spawn')?.execute({ prompt: 'work' }, ctxFor(store));
    const waiting = await tools.get('child_wait')?.execute({}, ctxFor(store));
    expect(waiting?.suspend).toMatchObject({ reason: 'child' });
    expect(waiting?.suspend?.reason).not.toBe('user');
    expect((await store.list('requests', { limit: 5 })).items).toHaveLength(0);
  });

  it('polls durably through awaitChildTasks without blocking the parent on a human', async () => {
    const store = createMemoryStore();
    await seed(store);
    const tools = await registry(store, new RecordingAdapter());
    await tools.get('child_spawn')?.execute({ prompt: 'work' }, ctxFor(store));
    const child = (await listChildTasks(store, PARENT))[0];
    let clock = 0;
    const pollNames: string[] = [];
    const journal = new Map<string, unknown>();
    const runtime = {
      now: () => RestatePromise.resolve(clock),
      sleep: (ms: number) => { clock += ms; return RestatePromise.resolve(undefined); },
      run: <T,>(name: string, action: () => Promise<T>): RestatePromise<T> => {
        pollNames.push(name);
        if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
        return RestatePromise.resolve(action().then(async (value) => {
          if (pollNames.length === 2) await store.patch('runs', String(child?.runId), { status: 'completed' });
          journal.set(name, structuredClone(value));
          return value;
        }));
      },
      race: <T,>(action: () => RestatePromise<T>): RestatePromise<T | 'cancelled'> => action(),
    };
    const outcome = await awaitChildTasks(store, { parentRunId: PARENT, waitKey: 'w1', pollMs: 100 }, runtime);
    expect(outcome.kind).toBe('done');
    expect(pollNames.length).toBeGreaterThanOrEqual(2);
    expect(pollNames[0]).toBe('childpoll:' + PARENT + ':w1:0');
    // A SECOND wait on the same parent gets its own namespace, so it cannot replay the first one.
    const secondNames: string[] = [];
    await awaitChildTasks(store, { parentRunId: PARENT, waitKey: 'w2', pollMs: 100 }, { ...runtime, run: <T,>(name: string, action: () => Promise<T>): RestatePromise<T> => { secondNames.push(name); return RestatePromise.resolve(action()); } });
    expect(secondNames[0]).toBe('childpoll:' + PARENT + ':w2:0');
    // Replaying wait 'w1' reuses its journaled polls instead of polling again.
    const before = pollNames.length;
    const replay = await awaitChildTasks(store, { parentRunId: PARENT, waitKey: 'w1', pollMs: 100 }, runtime);
    expect(replay.kind).toBe('done');
    // The replay re-walks the SAME journaled poll keys, never a fresh namespace or a second wait.
    expect(pollNames.slice(before)).toEqual(['childpoll:' + PARENT + ':w1:0', 'childpoll:' + PARENT + ':w1:1', 'childpoll:' + PARENT + ':w1:2']);
    // The parent stays RUNNING while it waits, and no human is ever asked.
    expect((await store.get('runs', PARENT))?.status).toBe('running');
    expect((await store.list('requests', { limit: 5 })).items).toHaveLength(0);
  });

  it('returns cancelled and timeout outcomes without writing anything', async () => {
    const store = createMemoryStore();
    await seed(store);
    const tools = await registry(store, new RecordingAdapter());
    await tools.get('child_spawn')?.execute({ prompt: 'work' }, ctxFor(store));
    const cancelled = await awaitChildTasks(store, { parentRunId: PARENT, waitKey: 'c1' }, { now: () => RestatePromise.resolve(0), sleep: () => RestatePromise.resolve(undefined), run: (_name, action) => RestatePromise.resolve(action()), race: () => RestatePromise.resolve('cancelled') });
    expect(cancelled.kind).toBe('cancelled');
    let clock = 0;
    const timeout = await awaitChildTasks(store, { parentRunId: PARENT, waitKey: 't1', timeoutMs: 200, pollMs: 100 }, { now: () => RestatePromise.resolve(clock), sleep: (ms: number) => { clock += ms; return RestatePromise.resolve(undefined); }, run: (_name, action) => RestatePromise.resolve(action()), race: (action) => action() });
    expect(timeout.kind).toBe('timeout');
    // A foreign/unknown requested id is reported truthfully, never as "all done".
    const missing = await awaitChildTasks(store, { parentRunId: PARENT, waitKey: 'm1', runIds: ['run_child_missing'] }, { now: () => RestatePromise.resolve(0), sleep: () => RestatePromise.resolve(undefined), run: (_name, action) => RestatePromise.resolve(action()), race: (action) => action() });
    expect(missing).toMatchObject({ kind: 'not_found', missing: ['run_child_missing'] });
    expect((await store.list('requests', { limit: 5 })).items).toHaveLength(0);
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
