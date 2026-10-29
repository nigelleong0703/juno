/**
 * PH12 child namespace production evidence.
 *
 * A child run resolves its scope from the canonical stored run (parent link, agent,
 * conversation, derived plan id and session). Its first todo_write creates its own child
 * plan; an empty or done child finishes while the parent root stays pending; a blocked
 * child never mutates the root; malformed bindings throw unreadable so the gate blocks
 * fail-closed instead of completing. The root persists across runs and lists child scopes.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Store, Tool, ToolContext, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { Item, Todo } from '@agent-desktop/public-contracts';
import { canonicalPlanId, listTaskPlans, readTaskPlan } from '../../../modules/tasks/state.js';
import { readBoundTaskPlan, readRunBinding } from '../../../modules/tasks/plan-binding.js';
import { blockOpenTasks, setTodoEvidence, writeBoundTaskPlan, writeTaskPlan } from '../../../modules/tasks/plan-write.js';
import { childPlanId } from '../../../modules/tasks/childRead.js';
import type { ChildRun } from '../../../modules/tasks/childRead.js';
import { childSessionKey } from '../../../modules/tasks/child.js';
import { createTodoWriteTool } from '../../../modules/tools/tools/todoWrite.js';
import { createTodoGate } from '../services/todo-gate.js';
import { readRunTasks } from '../services/task-hooks.js';
import { ScriptedModel } from '../testing/stubs.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const AGENT = 'agent-1';
const CONV = 'conv-1';
const AT = '2026-10-08T00:00:00.000Z';
const PARENT = 'run-parent';
const CHILD = 'run-child';

type ChildPlanDoc = Extract<Item, { type: 'plan' }> & { scope: 'child'; parentRunId: string };

function wake(): WakeEvent {
  return {
    id: 'w1', ownerId: 'owner-1', agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'go' }, at: AT, status: 'accepted',
  };
}

const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake()] };

function runContext(): RunContext {
  return {
    rand: { uuidv4: () => 'id-1' },
    run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({ id: 'awk', promise: RestatePromise.resolve(new Promise<T>(() => undefined)) }),
    drainInbox: (): RestatePromise<WakeEvent[]> => RestatePromise.resolve([]),
  };
}

function servicesFor(store: Store, tools: Tool[]): RunServices {
  const registry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registry };
}

function toolContext(store: Store, runId: string): ToolContext {
  return {
    ownerId: 'owner-1', agentId: AGENT, conversationId: CONV, runId, store, blobs: createMemoryBlobStore(),
    enqueuer: { enqueue: async () => ({ accepted: true }), stopRun: async () => undefined, resolveAwakeable: async () => undefined, scheduleRoutine: async () => undefined },
    wake: wake(),
    step: <T>(name: string, fn: () => Promise<T>): Promise<T> => fn(),
    signal: new AbortController().signal,
  };
}

function runDoc(id: string, extra?: Partial<ChildRun>): ChildRun {
  return {
    id, agentId: AGENT, conversationId: CONV, title: 't', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT, ...extra,
  };
}

async function seedParent(store: Store): Promise<void> {
  await store.put('runs', runDoc(PARENT), { conversationId: CONV });
}

async function seedChildRun(store: Store, childId: string): Promise<string> {
  const planId = childPlanId(AGENT, CONV, childId);
  await store.put('runs', runDoc(childId, { parentRunId: PARENT, planId, childSessionKey: childSessionKey(AGENT, CONV, childId) }), { conversationId: CONV });
  return planId;
}

async function seedChildPlan(store: Store, planId: string, childId: string, todos: Todo[]): Promise<void> {
  const child: ChildPlanDoc = {
    id: planId, conversationId: CONV, agentId: AGENT, type: 'plan', runId: childId,
    scope: 'child', parentRunId: PARENT, at: AT, todos,
  };
  await store.put('items', child, { conversationId: CONV, agentId: AGENT });
}

describe('child namespace', () => {
  it('the first todo_write creates the own child plan and leaves the root untouched', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await seedParent(store);
    await seedChildRun(store, CHILD);
    const tool = createTodoWriteTool({ store });
    const result = await tool.execute({ todos: [{ content: 'Child task one' }] }, toolContext(store, CHILD));
    expect(result.isError).not.toBe(true);
    const expectedPlanId = childPlanId(AGENT, CONV, CHILD);
    expect(result.details?.['planId']).toBe(expectedPlanId);
    const child = await readBoundTaskPlan(store, AGENT, CONV, CHILD);
    expect(child?.id).toBe(expectedPlanId);
    expect(child?.todos).toHaveLength(1);
    const root = await readTaskPlan(store, AGENT, CONV);
    expect(root?.todos.map((todo) => todo.id)).toEqual(['rt1']);
  });

  it('an empty child finishes while the parent root stays pending', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await seedParent(store);
    await seedChildRun(store, CHILD);
    const state = await readRunTasks(store, AGENT, CONV, CHILD);
    expect(state.kind).toBe('none');
    expect(await createTodoGate(runContext(), servicesFor(store, []), input, CHILD).settleFinal('final:0')).toBe('completed');
    expect((await readTaskPlan(store, AGENT, CONV))?.todos.find((todo) => todo.id === 'rt1')?.status).toBe('pending');
  });

  it('a done child finishes while the parent root stays pending', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await seedParent(store);
    const planId = await seedChildRun(store, CHILD);
    await seedChildPlan(store, planId, CHILD, [{ id: 'ct1', text: 'Child task', status: 'done' }]);
    expect(await createTodoGate(runContext(), servicesFor(store, []), input, CHILD).settleFinal('final:0')).toBe('completed');
    expect((await readTaskPlan(store, AGENT, CONV))?.todos.find((todo) => todo.id === 'rt1')?.status).toBe('pending');
  });

  it('a blocked child blocks without mutating the root', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await seedParent(store);
    const planId = await seedChildRun(store, CHILD);
    await seedChildPlan(store, planId, CHILD, [{ id: 'ct1', text: 'Child task', status: 'blocked', note: 'need input' }]);
    expect(await createTodoGate(runContext(), servicesFor(store, []), input, CHILD).settleFinal('final:0')).toBe('blocked');
    expect((await readTaskPlan(store, AGENT, CONV))?.todos.find((todo) => todo.id === 'rt1')?.status).toBe('pending');
    await blockOpenTasks(store, AGENT, CONV, 'waiting on review', CHILD);
    expect((await readTaskPlan(store, AGENT, CONV))?.todos.find((todo) => todo.id === 'rt1')?.status).toBe('pending');
  });

  it('a forged stored plan id fails closed and never touches the root', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await seedParent(store);
    await store.put('runs', runDoc(CHILD, { parentRunId: PARENT, planId: 'plan-forged', childSessionKey: childSessionKey(AGENT, CONV, CHILD) }), { conversationId: CONV });
    await expect(readRunBinding(store, AGENT, CONV, CHILD)).rejects.toThrow();
    const state = await readRunTasks(store, AGENT, CONV, CHILD);
    expect(state.kind).toBe('unreadable');
    expect(await createTodoGate(runContext(), servicesFor(store, []), input, CHILD).settleFinal('final:0')).toBe('blocked');
    await expect(writeBoundTaskPlan(store, AGENT, CONV, CHILD, [{ id: 'x1', text: 'X' }], true)).rejects.toThrow();
    expect((await readTaskPlan(store, AGENT, CONV))?.todos.map((todo) => todo.id)).toEqual(['rt1']);
  });

  it('a present child doc with the wrong parent throws instead of reading as none', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await seedParent(store);
    const planId = await seedChildRun(store, CHILD);
    const wrong: ChildPlanDoc = {
      id: planId, conversationId: CONV, agentId: AGENT, type: 'plan', runId: CHILD,
      scope: 'child', parentRunId: 'run-other-parent', at: AT, todos: [{ id: 'ct1', text: 'Child task', status: 'pending' }],
    };
    await store.put('items', wrong, { conversationId: CONV, agentId: AGENT });
    await expect(readBoundTaskPlan(store, AGENT, CONV, CHILD)).rejects.toThrow();
    expect((await readRunTasks(store, AGENT, CONV, CHILD)).kind).toBe('unreadable');
  });

  it('the root persists across runs with runId as last writer only', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-first', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await store.put('runs', runDoc('run-second'), { conversationId: CONV });
    const binding = await readRunBinding(store, AGENT, CONV, 'run-second');
    expect(binding.scope).toBe('root');
    expect(binding.planId).toBe(canonicalPlanId(AGENT, CONV));
    await writeTaskPlan(store, AGENT, CONV, 'run-second', [{ id: 'rt2', text: 'Second task', status: 'pending' }], true);
    const root = await readTaskPlan(store, AGENT, CONV);
    expect(root?.id).toBe(canonicalPlanId(AGENT, CONV));
    expect(root?.runId).toBe('run-second');
    expect(root?.todos.map((todo) => todo.id).sort()).toEqual(['rt1', 'rt2']);
  });

  it('gate evidence with the child run id targets the child scope only', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await seedParent(store);
    const planId = await seedChildRun(store, CHILD);
    await seedChildPlan(store, planId, CHILD, [{ id: 'ct1', text: 'Child task', status: 'pending' }]);
    const evidence = { at: AT, passed: true, summary: 'hook saw it' };
    await setTodoEvidence(store, AGENT, CONV, 'ct1', evidence, undefined, CHILD);
    expect((await readBoundTaskPlan(store, AGENT, CONV, CHILD))?.todos.find((todo) => todo.id === 'ct1')?.evidence).toMatchObject({ passed: true });
    expect((await readTaskPlan(store, AGENT, CONV))?.todos.find((todo) => todo.id === 'rt1')?.evidence).toBeUndefined();
  });

  it('lists child scopes beside the conversation root', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await seedParent(store);
    const planId = await seedChildRun(store, CHILD);
    await seedChildPlan(store, planId, CHILD, [{ id: 'ct1', text: 'Child task', status: 'pending' }]);
    const ids = (await listTaskPlans(store, AGENT)).map((item) => item.id);
    expect(ids).toContain(canonicalPlanId(AGENT, CONV));
    expect(ids).toContain(planId);
  });
});
