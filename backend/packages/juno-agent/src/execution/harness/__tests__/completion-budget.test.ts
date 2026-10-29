import { withBrowserCompletionGate } from '../services/browser-completion.js';
/**
 * PH10-budget: configured completion checks observe the frozen run budget.
 *
 * Driven through the real todo gate the run loop uses, with a real frozen budget: a spent budget
 * runs zero check effects and blocks with the budget reason on the run (never a false pass or a
 * retry hint); every executed check charges its trusted active duration once under a stable key and
 * persists it to the run usage; a fence-cache replay reuses the fenced effect and never double
 * charges; and once the budget is spent no further check effect runs. Without a budget the gate
 * behaves exactly as before (covered by completion-verification).
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it, vi } from 'vitest';
import { CHECK_TIMEOUT_MS } from '../services/check-runner.js';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Store, Tool, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { writeTaskPlan, setTodoChecks } from '../../../modules/tasks/plan-write.js';
import { createTodoGate } from '../services/todo-gate.js';
import { createRunBudget } from '../services/run-budget.js';
import { ScriptedModel } from '../testing/stubs.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

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

/** A direct branded context: no fake journal cache, so replay reuses the real fence result cache. */
function directContext(): RunContext {
  let next = 0;
  return {
    rand: { uuidv4: () => 'id-' + String(next++) },
    run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>() => ({ id: 'awk', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

/** The fake sandbox seam: every configured command goes through this tool, never the host. */
function sandboxTool(seen: string[], latencyMs = 30): Tool {
  return {
    name: 'shell.run',
    description: 'sandbox',
    parameters: {},
    replay: 'never',
    sideEffect: true,
    execute: async (args: unknown): Promise<ToolResult> => {
      const command = isRecord(args) && typeof args['command'] === 'string' ? args['command'] : '';
      seen.push(command);
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return { content: [{ type: 'text', text: 'ok ' + command }] };
    },
  };
}

function registryOf(tools: Tool[]): ToolRegistry {
  return { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
}

function servicesFor(store: Store, registry: ToolRegistry): RunServices {
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registry };
}

async function seededStore(): Promise<Store> {
  const store = createMemoryStore();
  // The owner's agent and direct chat: who is present is read from them (batch 5b), and the owner alone is the default.
  await store.put('agents', { id: AGENT, ownerId: OWNER, name: 'Nova' } as never);
  await store.put('conversations', { id: CONV, kind: 'direct', memberIds: [OWNER], agentIds: [AGENT] } as never);
  await store.put('runs', {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT,
  }, { conversationId: CONV });
  return store;
}

async function twoDoneTodos(store: Store): Promise<void> {
  await writeTaskPlan(store, AGENT, CONV, 'run-1', [
    { id: 't1', text: 'Ship the fix', status: 'done' },
    { id: 't2', text: 'Lint the fix', status: 'done' },
  ], true);
  const first = await setTodoChecks(store, AGENT, CONV, 't1', [{ id: 'c1', kind: 'command', spec: 'npm test', expect: 'ok' }]);
  const second = await setTodoChecks(store, AGENT, CONV, 't2', [{ id: 'c2', kind: 'command', spec: 'npm lint', expect: 'ok' }]);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
}

async function twoCustomTodos(store: Store, spec1: string, spec2: string): Promise<void> {
  await writeTaskPlan(store, AGENT, CONV, 'run-1', [
    { id: 't1', text: 'First job', status: 'done' },
    { id: 't2', text: 'Second job', status: 'done' },
  ], true);
  const first = await setTodoChecks(store, AGENT, CONV, 't1', [{ id: 'c1', kind: 'command', spec: spec1, expect: 'ok' }]);
  const second = await setTodoChecks(store, AGENT, CONV, 't2', [{ id: 'c2', kind: 'command', spec: spec2, expect: 'ok' }]);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
}

function behaviorTool(seen: string[]): Tool {
  return {
    name: 'shell.run',
    description: 'sandbox',
    parameters: {},
    replay: 'never',
    sideEffect: true,
    execute: async (args: unknown): Promise<ToolResult> => {
      const command = isRecord(args) && typeof args['command'] === 'string' ? args['command'] : '';
      seen.push(command);
      if (command === 'boom') throw new Error('sandbox exploded');
      if (command === 'hang forever') return new Promise<ToolResult>(() => undefined);
      return { content: [{ type: 'text', text: 'ok ' + command }] };
    },
  };
}


describe('completion checks observe the frozen run budget', () => {
  it('runs zero effects and blocks honestly when the budget is already spent', async () => {
    const store = await seededStore();
    await twoDoneTodos(store);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen)]));
    const budget = createRunBudget({ steps: 0 }, false);
    const ctx = directContext();
    const decision = await createTodoGate(ctx, services, input, 'run-1', undefined, budget).settleFinal('final:0');
    expect(decision).toBe('blocked');
    expect(seen).toHaveLength(0);
    const run = await store.get('runs', 'run-1');
    expect(run?.usage.steps).toBe(0);
    expect(run?.error ?? '').toContain('budget');
    const again = await createTodoGate(ctx, services, input, 'run-1', undefined, budget).settleFinal('final:1');
    expect(again).toBe('blocked');
    expect(seen).toHaveLength(0);
  });

  it('charges each executed check once, persists usage, and stops at exhaustion', async () => {
    const store = await seededStore();
    await twoDoneTodos(store);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen)]));
    const budget = createRunBudget({ steps: 1 }, false);
    const ctx = directContext();
    const gate = createTodoGate(ctx, services, input, 'run-1', undefined, budget);
    expect(await gate.settleFinal('final:0')).toBe('blocked');
    expect(seen).toHaveLength(1);
    const run = await store.get('runs', 'run-1');
    expect(run?.usage.steps).toBe(1);
    expect(run?.usage.computeSeconds).toBeLessThan(5);
    expect(run?.error ?? '').toContain('budget');
  });

  it('never repeats the effect or the charge on a fence-cache replay', async () => {
    const store = await seededStore();
    await twoDoneTodos(store);
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([sandboxTool(seen)]));
    const budget = createRunBudget({ steps: 4 }, false);
    const ctx = directContext();
    const gate = createTodoGate(ctx, services, input, 'run-1', undefined, budget);
    expect(await gate.settleFinal('final:0')).toBe('completed');
    expect(seen).toHaveLength(2);
    const once = await store.get('runs', 'run-1');
    expect(once?.usage.steps).toBe(2);
    expect(await gate.settleFinal('final:0')).toBe('completed');
    expect(seen).toHaveLength(2);
    const twice = await store.get('runs', 'run-1');
    expect(twice?.usage.steps).toBe(2);
    expect(twice?.usage.computeSeconds).toBe(once?.usage.computeSeconds);
  });
  it('a thrown first check still consumes budget and blocks the second check', async () => {
    const store = await seededStore();
    await twoCustomTodos(store, 'boom', 'npm lint');
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([behaviorTool(seen)]));
    const budget = createRunBudget({ steps: 1 }, false);
    const gate = createTodoGate(directContext(), services, input, 'run-1', undefined, budget);
    expect(await gate.settleFinal('final:0')).toBe('blocked');
    expect(seen).toEqual(['boom']);
    const run = await store.get('runs', 'run-1');
    expect(run?.usage.steps).toBe(1);
    expect(run?.usage.computeSeconds).toBeLessThan(5);
    expect(run?.error ?? '').toContain('budget');
  });

  it('a timed-out first check charges the full bound and blocks the second check', async () => {
    const store = await seededStore();
    await twoCustomTodos(store, 'hang forever', 'npm lint');
    const seen: string[] = [];
    const services = servicesFor(store, registryOf([behaviorTool(seen)]));
    const budget = createRunBudget({ steps: 1 }, false);
    const gate = createTodoGate(directContext(), services, input, 'run-1', undefined, budget);
    vi.useFakeTimers();
    try {
      const settling = gate.settleFinal('final:0');
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
      expect(await settling).toBe('blocked');
    } finally {
      vi.useRealTimers();
    }
    expect(seen).toEqual(['hang forever']);
    const run = await store.get('runs', 'run-1');
    expect(run?.usage.steps).toBe(1);
    expect(run?.usage.computeSeconds).toBe(CHECK_TIMEOUT_MS / 1000);
    expect(run?.error ?? '').toContain('budget');
  });
});

it('holds an otherwise finished run over an unverified browser contract and blocks repeated false finals', async () => {
  const store = await seededStore();
  await (store.forOwner?.(OWNER) ?? store).put('browserGoalGates', { id: 'bg', ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: 'run-1', stageId: 's', on: 'sandbox', status: 'pending', goal: 'Finish profile editing', completion: [{ match: { label: 'Nickname' }, property: 'value', equals: 'Mira' }], updatedAt: AT });
  const ctx = directContext(); const services = servicesFor(store, registryOf([]));
  const gate = withBrowserCompletionGate(createTodoGate(ctx, services, input, 'run-1'), ctx, services, input, 'run-1');
  expect(await gate.settleFinal('final:0')).toBe('continued');
  expect(await gate.settleFinal('final:1')).toBe('blocked');
  expect((await store.get('runs', 'run-1'))?.error).toContain('browser stage remains unverified');
  await store.patch('browserGoalGates', 'bg', { status: 'verified' });
  expect(await gate.settleFinal('final:2')).toBe('completed');
});
