/**
 * PH10 completion evidence, driven through the real todo gate the run loop uses.
 *
 * A task counts as done only when the checks the user configured actually pass in the sandbox. The
 * checks run inside the run's durable journal, a failure keeps working in the same run with an
 * actionable hint, and after the bounded attempts the task blocks with the observed evidence instead
 * of the run claiming finished work. Ordinary chat (no plan, or no configured checks) is unchanged.
 */
import { createMemoryBlobStore } from '@agent-desktop/db';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Store, Tool, ToolContext, ToolRegistry, ToolResult, WakeEvent } from '@agent-desktop/contracts';
import { todoCheckSchema, type Agent } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from './test-app.js';
import { getConfig } from '../config.js';
import { setTodoChecks, writeTaskPlan } from 'juno-agent/modules/tasks/plan-write';
import { createTodoWriteTool } from 'juno-agent/modules/tools/tools/todoWrite';
import { createRunCancellation } from 'juno-agent/execution/harness/services/cancel';
import { createTodoGate } from 'juno-agent/execution/harness/services/todo-gate';
import { ScriptedModel } from 'juno-agent/execution/harness/testing/stubs';
import type { RunContext, RunInput, RunServices } from 'juno-agent/execution/harness/services/run-types';

const OWNER = 'owner-1';
const AGENT = 'agent-1';
const CONV = 'conv-1';
const AT = '2026-10-08T00:00:00.000Z';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wake(): WakeEvent {
  return {
    id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'go' }, at: AT, status: 'accepted',
  };
}

const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake()] };

/** A journaling run context, like Restate's: a completed step replays instead of re-running. */
function runContext(): { ctx: RunContext; journal: Map<string, unknown> } {
  const journal = new Map<string, unknown>();
  let next = 0;
  return {
    journal,
    ctx: {
      rand: { uuidv4: () => 'id-' + String(next++) },
      run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
        if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
        return RestatePromise.resolve(action().then((value) => {
          journal.set(name, structuredClone(value));
          return value;
        }));
      },
      awakeable: <T>() => ({ id: 'awk', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
    },
  };
}

/** The fake sandbox seam: every configured command goes through this tool, never the host. */
function sandboxTool(seen: string[], respond: (command: string) => ToolResult): Tool {
  return {
    name: 'shell.run',
    description: 'sandbox',
    parameters: {},
    replay: 'never',
    sideEffect: true,
    execute: async (args: unknown): Promise<ToolResult> => {
      const command = isRecord(args) && typeof args['command'] === 'string' ? args['command'] : '';
      seen.push(command);
      return respond(command);
    },
  };
}

function registryOf(tools: Tool[]): ToolRegistry {
  return { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
}

function servicesFor(store: Store, registry: ToolRegistry): RunServices {
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registry };
}

/** An agent row stamped with its owner, as the API's visibility check reads it. */
async function seedAgent(store: Store, id: string, ownerId: string, published: boolean): Promise<void> {
  const agent: Agent & { ownerId: string } = {
    id, name: id, handle: id, title: '',    avatar: { shape: 'circle', color: 0, eyes: 'dot' },
    status: 'idle', section: 'Inbox', pinned: false, lastActivity: AT, unreadCount: 0,
    channels: [], macAccess: false, skillIds: [], pluginIds: [],
    sharing: { publishedToTeam: published }, createdAt: AT, updatedAt: AT, ownerId,
  };
  await store.put('agents', agent);
}

async function seededStore(): Promise<Store> {
  const store = withDefaultOwner(createMemoryStore(), getConfig().OWNER_ID);
  await store.put('runs', {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT,
  }, { conversationId: CONV });
  // Production always has the agent and its chat (a run's wake is refused without them), owned by the wake's owner.
  await seedAgent(store, AGENT, OWNER, false);
  await store.put('conversations', { id: CONV, kind: 'direct', title: 'Chat', agentIds: [AGENT], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT }, { conversationId: CONV });
  return store;
}

/** A done task with one configured command check, written through the product plan path. */
async function configuredPlan(store: Store, command = 'npm test', expectText = 'ok'): Promise<void> {
  await writeTaskPlan(store, AGENT, CONV, 'run-1', [{ id: 't1', text: 'Ship the fix', status: 'done' }], true);
  const updated = await setTodoChecks(store, AGENT, CONV, 't1', [{ id: 'c1', kind: 'command', spec: command, expect: expectText }]);
  expect(updated).not.toBeNull();
}

describe('configured completion checks in the run gate', () => {
  it('completes only when the configured check actually passes in the sandbox', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen, () => ({ content: [{ type: 'text', text: 'ok all good' }] }))]));
    const { ctx, journal } = runContext();
    const decision = await createTodoGate(ctx, services, input, 'run-1').settleFinal('final:0');
    expect(decision).toBe('completed');
    expect(seen).toEqual(['npm test']);
    // Durable: the observation is journaled, so a replay reuses it instead of re-running the command.
    expect([...journal.keys()].some((key) => key.startsWith('check:chk-') && key.endsWith(':result'))).toBe(true);
    const plan = (await store.list('items', { limit: 5 })).items.find((item) => item.type === 'plan');
    const todo = plan && plan.type === 'plan' ? plan.todos[0] : undefined;
    expect(todo?.evidence).toMatchObject({ passed: true });
  });

  it('a done task with a failing check keeps working, then blocks with the observed evidence', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([
      sandboxTool(seen, () => ({ content: [{ type: 'text', text: 'FAILED: expected 2, got 3' }], isError: true })),
    ]));
    const { ctx } = runContext();
    const gate = createTodoGate(ctx, services, input, 'run-1');
    expect(await gate.settleFinal('final:0')).toBe('continued');
    const hinted = JSON.stringify((await store.list('transcripts', { limit: 10 })).items);
    expect(hinted).toContain('completion checks did not pass');
    expect(hinted).toContain('t1');
    // The failed task never stays done: it returns to pending with the observed failure attached.
    const afterFirst = (await store.list('items', { limit: 5 })).items.find((item) => item.type === 'plan');
    const firstTodo = afterFirst && afterFirst.type === 'plan' ? afterFirst.todos[0] : undefined;
    expect(firstTodo?.status).toBe('pending');
    expect(firstTodo?.evidence).toMatchObject({ passed: false });

    // Bounded attempts: after the model marks the work done again and the check still fails, the run
    // blocks with the evidence instead of looping on the same failure.
    await writeTaskPlan(store, AGENT, CONV, 'run-1', [{ id: 't1', text: 'Ship the fix', status: 'done' }], true);
    expect(await gate.settleFinal('final:1')).toBe('blocked');
    const run = await store.get('runs', 'run-1');
    expect(run?.error).toContain('completion checks did not pass');
    const plan = (await store.list('items', { limit: 5 })).items.find((item) => item.type === 'plan');
    const todo = plan && plan.type === 'plan' ? plan.todos[0] : undefined;
    expect(todo?.status).toBe('blocked');
    expect(todo?.note).toContain('FAILED');
    expect(todo?.evidence).toMatchObject({ passed: false });
  });

  it('fails closed when no bound sandbox tool can run the check', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    const services = servicesFor(store, registryOf([]));
    const { ctx } = runContext();
    const gate = createTodoGate(ctx, services, input, 'run-1');
    expect(await gate.settleFinal('final:0')).toBe('continued');
    await writeTaskPlan(store, AGENT, CONV, 'run-1', [{ id: 't1', text: 'Ship the fix', status: 'done' }], true);
    expect(await gate.settleFinal('final:1')).toBe('blocked');
    expect((await store.get('runs', 'run-1'))?.error).toContain('no bound sandbox tool');
  });

  it('leaves ordinary work unchanged when no checks are configured', async () => {
    const store = await seededStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-1', [{ id: 't1', text: 'Chat', status: 'done' }], true);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen, () => ({ content: [{ type: 'text', text: 'ok' }] }))]));
    const { ctx } = runContext();
    expect(await createTodoGate(ctx, services, input, 'run-1').settleFinal('final:0')).toBe('completed');
    expect(seen).toEqual([]);
  });

  it('a model plan replacement cannot clear the configured checks', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    // Exactly what a model `merge:false` write looks like: same task, no checks in the draft.
    await writeTaskPlan(store, AGENT, CONV, 'run-1', [{ id: 't1', text: 'Ship the fix', status: 'done' }], false);
    const plan = (await store.list('items', { limit: 5 })).items.find((item) => item.type === 'plan');
    const todo = plan && plan.type === 'plan' ? plan.todos[0] : undefined;
    expect(todo?.checks).toHaveLength(1);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen, () => ({ content: [{ type: 'text', text: 'FAILED' }], isError: true }))]));
    expect(await createTodoGate(runContext().ctx, services, input, 'run-1').settleFinal('final:0')).toBe('continued');
    expect(seen).toEqual(['npm test']);
  });

  it('a model evidence claim is recorded unverified and never passes the gate', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    const tool = createTodoWriteTool({ store });
    const context: ToolContext = {
      ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: 'run-1', store, blobs: createMemoryBlobStore(),
      enqueuer: new NoopEnqueuer(), wake: wake(), step: async (_name, fn) => fn(), signal: AbortSignal.timeout(5_000),
    };
    await tool.execute({ todos: [{ id: 't1', content: 'Ship the fix', status: 'done', evidence: 'I ran make check' }] }, context);
    const plan = (await store.list('items', { limit: 5 })).items.find((item) => item.type === 'plan');
    const todo = plan && plan.type === 'plan' ? plan.todos[0] : undefined;
    expect(todo?.evidence).toMatchObject({ passed: false });
    expect(todo?.evidence?.summary).toContain('unverified claim');
    const services = servicesFor(store, registryOf([sandboxTool([], () => ({ content: [{ type: 'text', text: 'FAILED' }], isError: true }))]));
    expect(await createTodoGate(runContext().ctx, services, input, 'run-1').settleFinal('final:0')).toBe('continued');
  });

  it('a configured permission that denies stops the check instead of routing around it', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    await store.put('plugins', {
      id: 'plugin-1', name: 'P', publisher: 'p', category: 'Engineering', description: '', icon: 'i',
      installed: true, featured: false, accounts: [], usedByAgentIds: [AGENT],
      tools: [{ id: 'pt-1', pluginId: 'plugin-1', name: 'shell.run', description: '', permission: 'never' }],
    });
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen, () => ({ content: [{ type: 'text', text: 'ok' }] }))]));
    const { ctx } = runContext();
    const gate = createTodoGate(ctx, services, input, 'run-1');
    expect(await gate.settleFinal('final:0')).toBe('continued');
    // The permission was honoured: the command never ran, so the task cannot pass.
    expect(seen).toEqual([]);
    expect(todoCheckSchema.safeParse({ id: 'c1', kind: 'command', spec: 'npm test' }).success).toBe(true);
  });

  it('the step limit cannot complete work whose configured checks fail', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    const services = servicesFor(store, registryOf([sandboxTool([], () => ({ content: [{ type: 'text', text: 'FAILED' }], isError: true }))]));
    expect(await createTodoGate(runContext().ctx, services, input, 'run-1').afterStepLimit()).toBe('blocked');
    expect((await store.get('runs', 'run-1'))?.error).toContain('completion checks did not pass');
    const plan = (await store.list('items', { limit: 5 })).items.find((item) => item.type === 'plan');
    const todo = plan && plan.type === 'plan' ? plan.todos[0] : undefined;
    expect(todo?.status).toBe('blocked');
  });

  it('completes a run with no plan at all, with no sandbox call', async () => {
    const store = await seededStore();
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen, () => ({ content: [{ type: 'text', text: 'ok' }] }))]));
    const { ctx } = runContext();
    expect(await createTodoGate(ctx, services, input, 'run-1').settleFinal('final:0')).toBe('completed');
    expect(seen).toEqual([]);
  });

  it('a stop that already landed runs no check and writes no evidence', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen, () => ({ content: [{ type: 'text', text: 'ok' }] }))]));
    const cancellation = createRunCancellation({
      peek: async () => true,
      get: () => RestatePromise.resolve(new Promise<boolean>(() => {})),
    });
    cancellation.abort();
    expect(await createTodoGate(runContext().ctx, services, input, 'run-1', cancellation).settleFinal('final:0')).toBe('blocked');
    expect(seen).toEqual([]);
    const plan = (await store.list('items', { limit: 5 })).items.find((item) => item.type === 'plan');
    expect(plan && plan.type === 'plan' ? plan.todos[0]?.evidence : 'missing').toBeUndefined();
  });

  it('a stop during a hung check stops it once and writes no late evidence', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    let release: (value: boolean | undefined) => void = () => undefined;
    const cancelPromise = new Promise<boolean | undefined>((resolve) => {
      release = resolve;
    });
    const cancellation = createRunCancellation({
      peek: () => cancelPromise,
      get: () => RestatePromise.resolve(cancelPromise.then(() => true)),
    });
    const seen: string[] = [];
    const hung: Tool = {
      name: 'shell.run', description: 'sandbox', parameters: {}, replay: 'never', sideEffect: true,
      execute: async (): Promise<ToolResult> => {
        seen.push('started');
        return await new Promise<ToolResult>(() => undefined);
      },
    };
    const services = servicesFor(store, registryOf([hung]));
    const running = createTodoGate(runContext().ctx, services, input, 'run-1', cancellation).settleFinal('final:0');
    await new Promise((resolve) => setTimeout(resolve, 20));
    release(true);
    cancellation.abort();
    expect(await running).toBe('blocked');
    expect(seen).toEqual(['started']);
    const plan = (await store.list('items', { limit: 5 })).items.find((item) => item.type === 'plan');
    expect(plan && plan.type === 'plan' ? plan.todos[0]?.evidence : 'missing').toBeUndefined();
  });

  it('a replayed verification reuses the cached observation instead of re-running the command', async () => {
    const store = await seededStore();
    await configuredPlan(store);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen, () => ({ content: [{ type: 'text', text: 'ok' }] }))]));
    const { ctx } = runContext();
    expect(await createTodoGate(ctx, services, input, 'run-1').settleFinal('final:0')).toBe('completed');
    expect(seen).toEqual(['npm test']);
    expect(await createTodoGate(ctx, services, input, 'run-1').settleFinal('final:0')).toBe('completed');
    expect(seen).toEqual(['npm test']);
  });

  it('configures the checks through the authenticated route and the gate enforces them', async () => {
    const mem = createMemoryStore();
    const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() });
    const owner = getConfig().OWNER_ID;
    await seedAgent(mem, AGENT, owner, false);
    await mem.put('conversations', { id: CONV, kind: 'direct', title: 'Chat', agentIds: [AGENT], memberIds: [owner], unreadCount: 0, lastItemAt: AT, createdAt: AT }, { conversationId: CONV });
    await writeTaskPlan(withDefaultOwner(mem, owner), AGENT, CONV, 'run-1', [{ id: 't1', text: 'Ship the fix', status: 'done' }], true);
    const call = (path: string, body: unknown) => app.request(path, {
      method: 'PATCH',
      headers: { ...ownerHeaders(getConfig().OWNER_ID), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const path = '/v1/agents/' + AGENT + '/tasks/checks';
    const accepted = await call(path, { conversationId: CONV, todoId: 't1', checks: [{ id: 'c1', kind: 'command', spec: 'make check', expect: 'green' }] });
    expect(accepted.status).toBe(200);
    const written = await accepted.json() as { todos: Array<{ id: string; checks?: unknown[] }> };
    expect(written.todos.find((todo) => todo.id === 't1')?.checks).toHaveLength(1);

    // A foreign, unpublished agent is refused with no write to that agent's plan.
    await seedAgent(mem, 'agent-other', 'owner-other', false);
    const foreign = await call('/v1/agents/agent-other/tasks/checks', { conversationId: CONV, todoId: 't1', checks: [] });
    expect([403, 404]).toContain(foreign.status);

    const store = withDefaultOwner(mem, getConfig().OWNER_ID);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen, () => ({ content: [{ type: 'text', text: 'green' }] }))]));
    const { ctx } = runContext();
    const ownedInput: RunInput = { ...input, wakeEvents: [{ ...wake(), ownerId: owner }] };
    expect(await createTodoGate(ctx, services, ownedInput, 'run-1').settleFinal('final:0')).toBe('completed');
    expect(seen).toEqual(['make check']);
  });
});
