/**
 * PH-child-unknown: spawn-frozen onUnknown honor through the real loadRunBudget path.
 *
 * A spawn-frozen child whose limits say onUnknown 'ignore' must run under the static
 * known-spend ceiling even when the parent spend was unpriced or unmeasured; under an
 * explicit blocking policy only the unknown relevant to a frozen limit fails closed
 * (unmeasured tokens under a token limit, unknown price under the cost ceiling, which
 * always applies). Malformed frozen fields still fail closed instead of rereading settings.
 * Every case below drives the real loadRunBudget against a real store and durable context.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { LIMITS, type AssistantTurn, type Brain, type BrainContext, type Store } from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { requestScopedStore } from '../../../owner-context.js';
import { loadRunBudget } from '../services/run-budget.js';
import type { RunContext, RunServices } from '../services/run-types.js';

const AT = '2026-10-08T00:00:00.000Z';
const OWNER = 'owner-child-unknown';
const AGENT = 'agent-child-unknown';
const CONV = 'conv-child-unknown';

type ChildRow = Run & { parentRunId?: string; budgetSnapshot?: unknown };

function runDoc(id: string): Run {
  return {
    id, agentId: AGENT, conversationId: CONV, title: 'child-unknown', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  };
}

function frozenChild(id: string, snapshot: unknown): ChildRow {
  return { ...runDoc(id), parentRunId: 'run-parent', budgetSnapshot: snapshot };
}

/** A durable context that executes each step directly and rejects a repeated step name. */
function directContext(): RunContext {
  const used = new Set<string>();
  let seq = 0;
  return {
    rand: { uuidv4: () => 'id-' + String(seq++) },
    run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => {
      if (used.has(name)) throw new Error('duplicate durable step: ' + name);
      used.add(name);
      return RestatePromise.resolve(action());
    },
    awakeable: <T>() => ({ id: 'awake-' + String(seq++), promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve([]),
  };
}

async function world(): Promise<{ store: Store; raw: ReturnType<typeof createMemoryStore> }> {
  const raw = createMemoryStore();
  await raw.put('runs', runDoc('run-parent'), { conversationId: CONV });
  return { store: requestScopedStore(raw), raw };
}

/** Minimal services for budget helper tests: only the store is exercised. */
function budgetServices(store: Store): RunServices {
  const usage: AssistantTurn['usage'] = { inputTokens: 5, outputTokens: 2, costUsd: 0, costKnown: true };
  const brain: Brain = {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: 'x', agentId: 'x' };
    },
    async step(): Promise<AssistantTurn> {
      return { text: '', toolCalls: [], usage, stopReason: 'stop' };
    },
    shouldCompact: () => false,
    async compact(ctx: BrainContext): Promise<BrainContext> {
      return ctx;
    },
  };
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: { forAgent: async () => [], get: () => undefined } };
}

describe('PH-child-unknown spawn-frozen onUnknown', () => {
  it('permits a spawn-frozen onUnknown-ignore unpriced static-cap child', async () => {
    const { store, raw } = await world();
    await raw.put('runs', frozenChild('run-child-ignore', {
      limits: { costUsd: 2, onUnknown: 'ignore' }, explicitCost: false,
      parentSteps: 0, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0,
      parentMeasured: true, parentCostKnown: false, inheritedAt: AT,
    }), { conversationId: CONV });
    const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-child-ignore' });
    expect(budget.limits.costUsd).toBe(2);
    expect(budget.check().ok).toBe(true);
    budget.charge('model:0', { inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: false, measured: true }, 0);
    expect(budget.check().ok).toBe(true);
  });

  it('still enforces the static known-spend ceiling under onUnknown ignore', async () => {
    const { store, raw } = await world();
    await raw.put('runs', frozenChild('run-child-ceiling', {
      limits: { costUsd: 2, onUnknown: 'ignore' }, explicitCost: false,
      parentSteps: 0, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0,
      parentMeasured: true, parentCostKnown: false, inheritedAt: AT,
    }), { conversationId: CONV });
    const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-child-ceiling' });
    budget.charge('model:0', { inputTokens: 11, outputTokens: 7, costUsd: LIMITS.run.maxCostUsd + 1, costKnown: true, measured: true }, 0);
    expect(budget.check().ok).toBe(false);
  });

  it('stops a run with no explicit budget at the static active-time ceiling', async () => {
    const { store } = await world();
    const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER);
    expect(budget.limits.activeSeconds).toBe(LIMITS.run.maxActiveSeconds);
    budget.charge('tool:0', { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true, measured: true }, LIMITS.run.maxActiveSeconds * 1000);
    expect(budget.check().ok).toBe(false);
  });

  it('fails closed on the relevant unknown under an explicit blocking policy', async () => {
    const { store, raw } = await world();
    await raw.put('runs', frozenChild('run-child-token', {
      limits: { steps: 5, tokens: 100 }, parentSteps: 0, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0,
      parentMeasured: false, parentCostKnown: true, inheritedAt: AT,
    }), { conversationId: CONV });
    await raw.put('runs', frozenChild('run-child-cost', {
      limits: { steps: 5, costUsd: 1 }, parentSteps: 0, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0,
      parentMeasured: true, parentCostKnown: false, inheritedAt: AT,
    }), { conversationId: CONV });
    for (const id of ['run-child-token', 'run-child-cost']) {
      const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: id });
      expect(budget.limits.steps).toBe(0);
      expect(budget.check().ok).toBe(false);
    }
  });

  it('permits an irrelevant unknown under an explicit blocking policy', async () => {
    const { store, raw } = await world();
    await raw.put('runs', frozenChild('run-child-irrelevant', {
      limits: { steps: 5, costUsd: 1 }, parentSteps: 0, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0,
      parentMeasured: false, parentCostKnown: true, inheritedAt: AT,
    }), { conversationId: CONV });
    const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-child-irrelevant' });
    expect(budget.limits.steps).toBe(5);
    expect(budget.check().ok).toBe(true);
  });

  it('fails closed on malformed spawn-frozen snapshots instead of rereading settings', async () => {
    const { store, raw } = await world();
    await raw.put('runs', frozenChild('run-child-malformed', { limits: 'none' }), { conversationId: CONV });
    const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-child-malformed' });
    expect(budget.limits.steps).toBe(0);
    expect(budget.check().ok).toBe(false);
  });
});


describe('PH-child-unknown absent flags are not unknown', () => {
  it('permits an explicit blocking budget whose frozen row never claimed parent spend', async () => {
    const { store, raw } = await world();
    await raw.put('runs', frozenChild('run-child-absent', {
      limits: { steps: 5, costUsd: 1 }, parentSteps: 0, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0,
      inheritedAt: AT,
    }), { conversationId: CONV });
    const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-child-absent' });
    expect(budget.limits.steps).toBe(5);
    expect(budget.check().ok).toBe(true);
  });
});
