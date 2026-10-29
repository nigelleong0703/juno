import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type {
  Collection,
  Doc,
  ListPage,
  ListQuery,
  Store,
  ToolContext,
  WakeEvent,
} from '../../../contracts/index.js';
import type { Agent, Conversation, Item, Run } from '@agent-desktop/public-contracts';
import { createTodoWriteTool } from '../tools/todoWrite.js';
import {
  canonicalPlanId,
  listTaskPlans,
  readTaskPlan,
} from '../../tasks/state.js';
import { blockOpenTasks } from '../../tasks/plan-write.js';

const NOW = '2026-10-08T00:00:00.000Z';

function agentDoc(id: string): Agent {
  return {
    id,
    name: id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'Test agent',
    status: 'idle',
    section: 'Agents',
    pinned: false,
    lastActivity: NOW,
    unreadCount: 0,
    model: {
      planner: { provider: 'anthropic', model: 'claude-opus' },
      computer: { provider: 'anthropic', model: 'claude-opus' },
      fast: { provider: 'anthropic', model: 'claude-haiku' },
    },
    channels: [{ kind: 'chat', status: 'connected' }],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function conversationDoc(id: string, agentIds: string[]): Conversation {
  return {
    id,
    kind: 'direct',
    agentIds,
    memberIds: ['user-1'],
    unreadCount: 0,
    lastItemAt: NOW,
    createdAt: NOW,
  };
}

function runDoc(id: string, agentId: string, conversationId: string): Run {
  return {
    id,
    agentId,
    conversationId,
    title: 'Test run',
    status: 'running',
    kind: 'chat',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: NOW,
    lastActivityAt: NOW,
  };
}

/** A legacy plan item: no `agentId`, so its author is only its bound run. */
function legacyPlan(id: string, conversationId: string, runId: string, at: string): Item {
  return {
    id,
    conversationId,
    at,
    type: 'plan',
    runId,
    todos: [{ id: 'legacy-1', text: 'Legacy task', status: 'pending' }],
  };
}

function wakeFor(agentId: string, conversationId: string): WakeEvent {
  return {
    id: 'wke_' + agentId,
    ownerId: 'user-1',
    agentId,
    sessionKey: agentId + ':' + conversationId,
    conversationId,
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: {},
    at: NOW,
    status: 'accepted',
  };
}

function context(store: Store, overrides: Partial<ToolContext> = {}): ToolContext {
  const agentId = overrides.agentId ?? 'agent-1';
  const conversationId = overrides.conversationId ?? 'conv-1';
  return {
    ownerId: 'user-1',
    agentId,
    conversationId,
    runId: 'run-1',
    store,
    blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    wake: wakeFor(agentId, conversationId),
    step: async (_name, fn) => fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function seedConversationGraph(store: Store): Promise<void> {
  await store.put('agents', agentDoc('agent-1'));
  await store.put('agents', agentDoc('agent-2'));
  await store.put('conversations', conversationDoc('conv-1', ['agent-1']));
  await store.put('conversations', conversationDoc('conv-foreign', ['agent-2']));
}

/** A store whose item pagination never terminates, to pin the fail-visible scan guards. */
function endlessPageStore(next: (page: number) => string): Store {
  const base = createMemoryStore();
  let page = 0;
  return {
    ...base,
    list: async <C extends Collection>(_collection: C, _query?: ListQuery): Promise<ListPage<Doc<C>>> => ({
      items: [],
      nextCursor: next(page++),
    }),
  };
}

describe('persistent task plans', () => {
  let store: Store;

  beforeEach(() => {
    store = createMemoryStore();
  });

  it('fences its side effect with replay:never so a crash cannot duplicate tasks', () => {
    const tool = createTodoWriteTool({ store });
    expect(tool.replay).toBe('never');
    expect(tool.sideEffect).toBe(true);
  });

  it('keeps one canonical plan with stable ids and merges across runs', async () => {
    await seedConversationGraph(store);
    const tool = createTodoWriteTool({ store });

    const first = await tool.execute(
      { todos: [{ id: 't1', content: 'Draft outline' }, { id: 't2', content: 'Collect sources' }] },
      context(store, { runId: 'run-1' }),
    );
    expect(first.isError).not.toBe(true);

    const second = await tool.execute(
      { todos: [{ id: 't1', content: 'Draft outline v2' }, { id: 't3', content: 'Write memo' }] },
      context(store, { runId: 'run-2' }),
    );
    expect(second.isError).not.toBe(true);

    const plan = await readTaskPlan(store, 'agent-1', 'conv-1');
    expect(plan?.id).toBe(canonicalPlanId('agent-1', 'conv-1'));
    expect(plan?.agentId).toBe('agent-1');
    expect(plan?.runId).toBe('run-2');
    // Unmentioned t2 survives; t1 updates in place; t3 is appended.
    expect(plan?.todos.map((todo) => todo.id)).toEqual(['t1', 't2', 't3']);
    expect(plan?.todos[0]?.text).toBe('Draft outline v2');
    expect(plan?.todos[1]?.text).toBe('Collect sources');
    expect(plan?.todos[2]?.text).toBe('Write memo');

    const plans = (await store.list('items', { limit: 50 })).items.filter((item) => item.type === 'plan');
    expect(plans).toHaveLength(1);
  });

  it('replaces the scope only on an explicit merge:false, including an explicit clear', async () => {
    await seedConversationGraph(store);
    const tool = createTodoWriteTool({ store });

    await tool.execute(
      { todos: [{ id: 't1', content: 'A' }, { id: 't2', content: 'B' }] },
      context(store, { runId: 'run-1' }),
    );
    await tool.execute(
      { todos: [{ id: 'x1', content: 'Only' }], merge: false },
      context(store, { runId: 'run-2' }),
    );
    const replaced = await readTaskPlan(store, 'agent-1', 'conv-1');
    expect(replaced?.todos.map((todo) => todo.id)).toEqual(['x1']);

    const cleared = await tool.execute({ todos: [], merge: false }, context(store, { runId: 'run-3' }));
    expect(cleared.isError).not.toBe(true);
    const afterClear = await readTaskPlan(store, 'agent-1', 'conv-1');
    expect(afterClear?.todos).toEqual([]);

    // An accidental empty default merge must not wipe the plan.
    await tool.execute({ todos: [{ id: 'y1', content: 'Y' }] }, context(store, { runId: 'run-4' }));
    const accidental = await tool.execute({ todos: [] }, context(store, { runId: 'run-5' }));
    expect(accidental.isError).toBe(true);
    const kept = await readTaskPlan(store, 'agent-1', 'conv-1');
    expect(kept?.todos.map((todo) => todo.id)).toEqual(['y1']);
  });

  it('refuses a blocked todo without a note and leaves the plan untouched', async () => {
    await seedConversationGraph(store);
    const tool = createTodoWriteTool({ store });
    await tool.execute({ todos: [{ id: 't1', content: 'Ship it' }] }, context(store, { runId: 'run-1' }));

    const refused = await tool.execute(
      { todos: [{ id: 'b1', content: 'Deploy', status: 'blocked' }] },
      context(store, { runId: 'run-2' }),
    );
    expect(refused.isError).toBe(true);
    const unchanged = await readTaskPlan(store, 'agent-1', 'conv-1');
    expect(unchanged?.todos.map((todo) => todo.id)).toEqual(['t1']);

    const accepted = await tool.execute(
      { todos: [{ id: 'b1', content: 'Deploy', status: 'blocked', note: 'Needs production credentials' }] },
      context(store, { runId: 'run-3' }),
    );
    expect(accepted.isError).not.toBe(true);
    const blocked = await readTaskPlan(store, 'agent-1', 'conv-1');
    const b1 = blocked?.todos.find((todo) => todo.id === 'b1');
    expect(b1?.status).toBe('blocked');
    expect(b1?.note).toBe('Needs production credentials');
  });

  it('refuses a run whose agent does not own the conversation', async () => {
    await seedConversationGraph(store);
    const tool = createTodoWriteTool({ store });

    const refused = await tool.execute(
      { todos: [{ id: 't1', content: 'Sneaky' }] },
      context(store, { agentId: 'agent-1', conversationId: 'conv-foreign' }),
    );
    expect(refused.isError).toBe(true);
    const plans = (await store.list('items', { limit: 50 })).items.filter((item) => item.type === 'plan');
    expect(plans).toHaveLength(0);
  });

  it('attributes legacy plans through the bound run and never bleeds foreign agents', async () => {
    await seedConversationGraph(store);
    await store.put('conversations', conversationDoc('conv-legacy', ['agent-1']));
    await store.put('conversations', conversationDoc('conv-other', ['agent-2']));
    await store.put('runs', runDoc('run-legacy', 'agent-1', 'conv-legacy'));
    await store.put('runs', runDoc('run-foreign', 'agent-2', 'conv-other'));
    await store.put('items', legacyPlan('plan-legacy', 'conv-legacy', 'run-legacy', '2026-10-08T01:00:00.000Z'), {
      conversationId: 'conv-legacy',
      runId: 'run-legacy',
    });
    await store.put('items', legacyPlan('plan-foreign', 'conv-other', 'run-foreign', '2026-10-08T02:00:00.000Z'), {
      conversationId: 'conv-other',
      runId: 'run-foreign',
    });

    const legacy = await readTaskPlan(store, 'agent-1', 'conv-legacy');
    expect(legacy?.id).toBe('plan-legacy');
    // The resolved author is normalized onto the returned item for the tasks API/UI.
    expect(legacy?.agentId).toBe('agent-1');
    expect(await readTaskPlan(store, 'agent-2', 'conv-legacy')).toBeNull();

    const forAgentOne = await listTaskPlans(store, 'agent-1');
    expect(forAgentOne.map((plan) => plan.id)).toEqual(['plan-legacy']);
    const forAgentTwo = await listTaskPlans(store, 'agent-2');
    expect(forAgentTwo.map((plan) => plan.id)).toEqual(['plan-foreign']);
    expect(forAgentTwo[0]?.agentId).toBe('agent-2');
  });

  it('blocks open tasks with a real reason and preserves done entries', async () => {
    await seedConversationGraph(store);
    const tool = createTodoWriteTool({ store });
    await tool.execute(
      { todos: [{ id: 't1', content: 'Open', status: 'in_progress' }, { id: 't2', content: 'Closed', status: 'done' }] },
      context(store, { runId: 'run-1' }),
    );

    const blocked = await blockOpenTasks(store, 'agent-1', 'conv-1', 'Waiting on the security review');
    expect(blocked?.todos[0]?.status).toBe('blocked');
    expect(blocked?.todos[0]?.note).toBe('Waiting on the security review');
    expect(blocked?.todos[1]?.status).toBe('done');
    expect(blocked?.todos[1]?.note).toBeUndefined();

    await expect(blockOpenTasks(store, 'agent-1', 'conv-1', '   ')).rejects.toThrow();
    expect(await blockOpenTasks(store, 'agent-1', 'no-such-conv', 'reason')).toBeNull();
  });

  it('derives collision-free canonical ids for ambiguous id pairs', () => {
    expect(canonicalPlanId('a-b', 'c')).toBe(canonicalPlanId('a-b', 'c'));
    expect(canonicalPlanId('a-b', 'c')).not.toBe(canonicalPlanId('a', 'b-c'));
    expect(canonicalPlanId('a', 'b:c')).not.toBe(canonicalPlanId('a:b', 'c'));
  });

  it('preserves omitted status and note on an id update', async () => {
    await seedConversationGraph(store);
    const tool = createTodoWriteTool({ store });
    await tool.execute(
      { todos: [{ id: 't1', content: 'Review', status: 'in_progress', note: 'From Alice' }] },
      context(store, { runId: 'run-1' }),
    );
    await tool.execute({ todos: [{ id: 't1', content: 'Review v2' }] }, context(store, { runId: 'run-2' }));
    const plan = await readTaskPlan(store, 'agent-1', 'conv-1');
    expect(plan?.todos[0]?.text).toBe('Review v2');
    expect(plan?.todos[0]?.status).toBe('in_progress');
    expect(plan?.todos[0]?.note).toBe('From Alice');

    await tool.execute({ todos: [{ id: 't1', content: 'Review v2', status: 'done' }] }, context(store, { runId: 'run-3' }));
    const finished = await readTaskPlan(store, 'agent-1', 'conv-1');
    expect(finished?.todos[0]?.status).toBe('done');
    expect(finished?.todos[0]?.note).toBe('From Alice');
  });

  it('keeps the canonical plan over a newer legacy snapshot for the same conversation', async () => {
    await seedConversationGraph(store);
    const tool = createTodoWriteTool({ store });
    await tool.execute(
      { todos: [{ id: 't1', content: 'Done work', status: 'done' }] },
      context(store, { runId: 'run-1' }),
    );
    // A newer legacy plan attributed to the same agent must not override the canonical one.
    await store.put('runs', runDoc('run-legacy', 'agent-1', 'conv-1'));
    await store.put('items', legacyPlan('plan-legacy', 'conv-1', 'run-legacy', '2099-01-01T00:00:00.000Z'), {
      conversationId: 'conv-1',
      runId: 'run-legacy',
    });

    const plans = await listTaskPlans(store, 'agent-1');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe(canonicalPlanId('agent-1', 'conv-1'));
    expect(plans[0]?.todos[0]?.status).toBe('done');
    const direct = await readTaskPlan(store, 'agent-1', 'conv-1');
    expect(direct?.id).toBe(canonicalPlanId('agent-1', 'conv-1'));
  });

  it('fails visibly when item pagination does not terminate', async () => {
    await expect(listTaskPlans(endlessPageStore(() => 'stuck'), 'agent-1')).rejects.toThrow(/did not advance/);
    await expect(listTaskPlans(endlessPageStore((page) => 'c' + page), 'agent-1')).rejects.toThrow(/exceeded/);
  });
});
