/**
 * CT-context: a child buildContext reads its canonical bound plan, never the parent root.
 *
 * A root session renders the root plan; a child session renders only its own child plan;
 * a valid child run without a plan renders no task section; malformed, foreign or
 * missing child bindings fail closed with an unreadable marker instead of root fallback.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, WakeEvent } from '../../../contracts/index.js';
import type { Item, Todo } from '@agent-desktop/public-contracts';
import { writeTaskPlan } from '../../../modules/tasks/plan-write.js';
import { childPlanId, type ChildRun } from '../../../modules/tasks/childRead.js';
import { childSessionKey } from '../../../modules/tasks/child.js';
import { buildContext } from '../context.js';
import { contextText } from './context-text.js';

const AGENT = 'agent-1';
const CONV = 'conv-1';
const AT = '2026-10-08T00:00:00.000Z';
const PARENT = 'run-parent';
const CHILD = 'run-child-1';
const ROOT_SESSION = AGENT + ':' + CONV;

type ChildPlanDoc = Extract<Item, { type: 'plan' }> & { scope: 'child'; parentRunId: string };

function runDoc(id: string, extra?: Partial<ChildRun>): ChildRun {
  return {
    id, agentId: AGENT, conversationId: CONV, title: 't', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT, ...extra,
  };
}

function wakeFor(sessionKey: string): WakeEvent {
  return {
    id: 'w1', ownerId: 'owner-1', agentId: AGENT, sessionKey, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'go' }, at: AT, status: 'accepted',
  };
}


async function systemContent(store: Store, sessionKey: string): Promise<string> {
  const ctx = await buildContext(store, {
    agentId: AGENT,
    conversationId: CONV,
    sessionKey,
    wake: [wakeFor(sessionKey)],
  });
  return contextText(ctx);
}

async function seedRoot(store: Store): Promise<void> {
  await writeTaskPlan(store, AGENT, CONV, 'run-root', [{ id: 'rt1', text: 'Root task', status: 'pending' }], true);
}

async function seedChildRun(store: Store, childId: string): Promise<string> {
  const planId = childPlanId(AGENT, CONV, childId);
  await store.put('runs', runDoc(PARENT), { conversationId: CONV });
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

describe('child task context isolation', () => {
  it('a root session renders the pending root task', async () => {
    const store = createMemoryStore();
    await seedRoot(store);
    const content = await systemContent(store, ROOT_SESSION);
    expect(content).toContain('## Current tasks');
    expect(content).toContain('Root task');
  });

  it('a child session renders its own task and never the parent root', async () => {
    const store = createMemoryStore();
    await seedRoot(store);
    const planId = await seedChildRun(store, CHILD);
    await seedChildPlan(store, planId, CHILD, [{ id: 'ct1', text: 'Child task', status: 'pending' }]);
    const content = await systemContent(store, childSessionKey(AGENT, CONV, CHILD));
    expect(content).toContain('## Current tasks');
    expect(content).toContain('Child task');
    expect(content).not.toContain('Root task');
  });

  it('a valid child run without a plan renders no task section', async () => {
    const store = createMemoryStore();
    await seedRoot(store);
    await seedChildRun(store, CHILD);
    const content = await systemContent(store, childSessionKey(AGENT, CONV, CHILD));
    expect(content).not.toContain('## Current tasks');
    expect(content).not.toContain('Root task');
  });

  it('a missing child run fails closed instead of falling back to the root', async () => {
    const store = createMemoryStore();
    await seedRoot(store);
    const content = await systemContent(store, childSessionKey(AGENT, CONV, 'run_child_missing'));
    expect(content).toContain('Task state unreadable');
    expect(content).not.toContain('Root task');
  });

  it('malformed and foreign child sessions fail closed instead of falling back to the root', async () => {
    const store = createMemoryStore();
    await seedRoot(store);
    const malformed = await systemContent(store, ROOT_SESSION + '::child:');
    expect(malformed).toContain('Task state unreadable');
    expect(malformed).not.toContain('Root task');
    const foreign = await systemContent(store, 'agent-evil:' + CONV + '::child:run_child_x');
    expect(foreign).toContain('Task state unreadable');
    expect(foreign).not.toContain('Root task');
  });
});
