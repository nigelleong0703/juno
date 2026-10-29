/**
 * PH12 child-plan namespace, through the production gate and the owned plan helpers.
 *
 * A child run reads and writes only its own derived child scope; the root plan keeps the
 * agent+conversation work across runs (its runId is just the last writer, never a gate
 * equality). Children list as their own scopes, and a write can never be redirected into
 * another agent or conversation plan.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Store, Tool, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import type { Item, Todo } from '@agent-desktop/public-contracts';
import { readRunBinding } from '../../../modules/tasks/plan-binding.js';
import { setTodoChecks, writeTaskPlan } from '../../../modules/tasks/plan-write.js';
import { childPlanId } from '../../../modules/tasks/childRead.js';
import { childSessionKey } from '../../../modules/tasks/child.js';
import { createTodoGate } from '../services/todo-gate.js';
import { ScriptedModel } from '../testing/stubs.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';
import type { ChildRun } from '../../../modules/tasks/childRead.js';

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

function sandbox(seen: string[]): Tool {
  return {
    name: 'shell.run', description: 'sandbox', parameters: {}, replay: 'never', sideEffect: true,
    execute: async (): Promise<ToolResult> => { seen.push('ran'); return { content: [{ type: 'text', text: 'ok' }] }; },
  };
}

function servicesFor(store: Store, tools: Tool[]): RunServices {
  const registry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry: registry };
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

async function seedChildRun(store: Store): Promise<string> {
  const planId = childPlanId(AGENT, CONV, CHILD);
  const session = childSessionKey(AGENT, CONV, CHILD);
  await store.put('runs', runDoc(CHILD, { parentRunId: PARENT, planId, childSessionKey: session }), { conversationId: CONV });
  return planId;
}

async function seedChildPlan(store: Store, planId: string): Promise<void> {
  const todos: Todo[] = [{ id: 'ct1', text: 'Child task', status: 'done', checks: [{ id: 'c1', kind: 'command', spec: 'npm test', expect: 'ok' }] }];
  const child: ChildPlanDoc = {
    id: planId, conversationId: CONV, agentId: AGENT, type: 'plan', runId: CHILD,
    scope: 'child', parentRunId: PARENT, at: AT, todos,
  };
  await store.put('items', child, { conversationId: CONV, agentId: AGENT });
}

describe('child plan namespace', () => {
  it('an unbound run keeps reading the root plan across runs', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await store.put('runs', runDoc('run-next'), { conversationId: CONV });
    expect(await readRunBinding(store, AGENT, CONV, 'run-next')).toMatchObject({ scope: 'root' });
    const seen: string[] = [];
    const services = servicesFor(store, [sandbox(seen)]);
    expect(await createTodoGate(runContext(), services, input, 'run-next').settleFinal('final:0')).toBe('continued');
    expect(seen).toEqual([]);
  });

  it('refuses a write into another agent or conversation plan', async () => {
    const store = createMemoryStore();
    await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
    await seedParent(store);
    const planId = await seedChildRun(store);
    await seedChildPlan(store, planId);
    expect(await setTodoChecks(store, AGENT, 'other-conv', 'ct1', [], planId)).toBeNull();
    expect(await setTodoChecks(store, 'agent-2', CONV, 'ct1', [], planId)).toBeNull();
    const updated = await setTodoChecks(store, AGENT, CONV, 'ct1', [{ id: 'c1', kind: 'command', spec: 'npm test' }], planId);
    expect(updated?.id).toBe(planId);
  });
});
