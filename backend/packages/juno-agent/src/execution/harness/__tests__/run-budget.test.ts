/**
 * PH11 budget integration through the real Run loop.
 *
 * The observed model spend is charged after the model call and enforced BEFORE any tool or reply: a
 * known lower bound over the static per-run cost cap blocks with the work preserved, an unpriced
 * gateway never blocks an ordinary run (the static floor only bounds known spend), and an explicit
 * account budget with an unknown price blocks unless its own onUnknown policy says otherwise. The
 * canonical run usage is persisted with the real numbers, including the overshooting call.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { LIMITS, type AssistantTurn, type Brain, type BrainContext, type Store, type Tool, type ToolRegistry, type WakeEvent } from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { requestScopedStore } from '../../../owner-context.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { checkWithChildren, createRunBudget } from '../services/run-budget.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const AT = '2026-10-08T00:00:00.000Z';
const OWNER = 'owner-budget';
const AGENT = 'agent-budget';
const CONV = 'conv-budget';

const wake: WakeEvent = {
  id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
  payload: { text: 'go', addressed: 'direct' }, at: AT, status: 'accepted',
};
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake] };

function runDoc(): Run {
  return {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'budget', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  };
}

function context(): RunContext {
  const journal = new Map<string, unknown>();
  const used = new Set<string>();
  let seq = 0;
  return {
    rand: { uuidv4: () => 'id-' + String(seq++) },
    run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => {
      if (used.has(name)) throw new Error('duplicate durable step: ' + name);
      used.add(name);
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(action().then((value) => {
        journal.set(name, structuredClone(value));
        return value;
      }));
    },
    awakeable: <T>() => ({ id: 'awake-' + String(seq++), promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

/** A model that proposes the effect once, then finishes, reporting the given usage every call. */
function spendingBrain(usage: AssistantTurn['usage']): { brain: Brain; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    brain: {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(): Promise<AssistantTurn> {
        calls += 1;
        if (calls === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'effect', arguments: {} }], usage, stopReason: 'tool_calls' };
        return { text: 'done', toolCalls: [], usage, stopReason: 'stop' };
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    },
  };
}

const registry = (executions: { count: number }): ToolRegistry => {
  const tool: Tool = {
    name: 'effect', description: 'effect', parameters: { type: 'object' }, replay: 'safe', sideEffect: true,
    async execute() {
      executions.count += 1;
      return { content: [{ type: 'text', text: 'effect done' }] };
    },
  };
  return { forAgent: async () => [tool], get: (name) => (name === tool.name ? tool : undefined) };
};

async function drive(usage: AssistantTurn['usage'], executions: { count: number }, store: Store, ctx: RunContext = context()): Promise<unknown> {
  const brain = spendingBrain(usage);
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: brain.brain, toolRegistry: registry(executions) };
  return await runLoop(ctx, services, input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED)
    .then((value) => value, (error: unknown) => error);
}

/** A context that FAILS if any durable clock is read while a ctx.run action is executing. */
function enforcingContext(): RunContext {
  const base = context();
  let insideAction = false;
  return {
    ...base,
    date: {
      now: () => {
        if (insideAction) throw new Error('durable ctx.date.now() called inside a ctx.run action');
        return RestatePromise.resolve(Date.now());
      },
    },
    localDate: { now: () => Date.now() },
    run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> =>
      base.run(name, async () => {
        insideAction = true;
        try {
          return await action();
        } finally {
          insideAction = false;
        }
      }),
  };
}

async function world(settings?: Record<string, unknown>): Promise<{ store: Store; raw: ReturnType<typeof createMemoryStore> }> {
  const raw = createMemoryStore();
  await raw.put('runs', runDoc() as never, { conversationId: CONV });
  if (settings !== undefined) await raw.put('settings', { id: 'app-settings-' + OWNER, ...settings } as never);
  return { store: requestScopedStore(raw), raw };
}

describe('PH11 budget integration', () => {
  it('never reads a durable clock inside a ctx.run action', async () => {
    const { store } = await world();
    const executions = { count: 0 };

    // The enforcing context throws if ctx.date.now() is reached from inside an action, so a passing
    // run proves the elapsed time came from the local clock and was serialized with the step.
    const outcome = await drive({ inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: true }, executions, store, enforcingContext());
    expect(outcome).toBe('completed');
  });

  it('charges the active time a compaction measured, outside its durable step', async () => {
    const { store, raw } = await world();
    const executions = { count: 0 };
    let compacted = false;
    const inner = spendingBrain({ inputTokens: 5, outputTokens: 2, costUsd: 0, costKnown: true });
    const brain: Brain = {
      ...inner.brain,
      shouldCompact: () => !compacted,
      async compact(ctx) {
        compacted = true;
        // The brain is the producer: it reports what the compaction actually cost and measured.
        return { ...ctx, compactionMetrics: { durationMs: 40 } };
      },
    };
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry(executions) };

    const outcome = await runLoop(context(), services, input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('completed');
    expect((await raw.get('runs', 'run-1'))?.usage?.computeSeconds).toBeGreaterThanOrEqual(0.04);
  });

  it('blocks before the first model call when the frozen budget is already exhausted', async () => {
    const { store, raw } = await world({ usage: { steps: 0 } });
    const executions = { count: 0 };
    const brain = spendingBrain({ inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: true });
    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: brain.brain, toolRegistry: registry(executions) };

    const outcome = await runLoop(context(), services, input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);

    expect(outcome).toBe('blocked');
    expect(brain.calls()).toBe(0);
    expect((await raw.get('runs', 'run-1'))?.error).toContain('step budget reached');
  });

  it('persists cache tokens and keeps an unknown price unknown instead of a measured zero', async () => {
    const { store, raw } = await world();
    const executions = { count: 0 };

    const outcome = await drive({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 7, costUsd: 0, costKnown: false }, executions, store);

    expect(outcome).toBe('completed');
    expect((await raw.get('runs', 'run-1'))?.usage).toMatchObject({
      inputTokens: 10, outputTokens: 4, cacheReadTokens: 60, cacheWriteTokens: 14, costUsd: 0, costKnown: false, steps: 3,
    });
  });

  it('enforces the static cost floor over known spend before any tool or reply', async () => {
    const { store, raw } = await world();
    const executions = { count: 0 };

    const outcome = await drive({ inputTokens: 11, outputTokens: 7, costUsd: LIMITS.run.maxCostUsd + 1, costKnown: true }, executions, store);

    expect(outcome).toBe('blocked');
    expect(executions.count).toBe(0);
    const run = await raw.get('runs', 'run-1');
    expect(run?.error).toContain('cost budget reached');
    // The real numbers of the overshooting call are persisted, not a rounded or invented zero.
    expect(run?.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, costUsd: LIMITS.run.maxCostUsd + 1, steps: 1 });
  });

  it('does not block an ordinary run when the gateway price is unknown', async () => {
    const { store, raw } = await world();
    const executions = { count: 0 };

    const outcome = await drive({ inputTokens: 9, outputTokens: 4, costUsd: 0, costKnown: false }, executions, store);

    expect(outcome).toBe('completed');
    expect(executions.count).toBe(1);
    expect((await raw.get('runs', 'run-1'))?.usage).toMatchObject({ inputTokens: 18, outputTokens: 8, costUsd: 0, steps: 3 });
  });

  it('blocks under an explicit cost budget whose price is unknown', async () => {
    const { store, raw } = await world({ usage: { costUsd: 5 } });
    const executions = { count: 0 };

    const outcome = await drive({ inputTokens: 10, outputTokens: 10, costUsd: 0, costKnown: false }, executions, store);

    expect(outcome).toBe('blocked');
    expect(executions.count).toBe(0);
    const run = await raw.get('runs', 'run-1');
    expect(run?.error).toContain('cost budget cannot be enforced');
  });

  it('honours an explicit onUnknown policy that allows unpriced spend', async () => {
    const { store } = await world({ usage: { costUsd: 5, onUnknown: 'ignore' } });
    const executions = { count: 0 };

    const outcome = await drive({ inputTokens: 10, outputTokens: 10, costUsd: 0, costKnown: false }, executions, store);

    expect(outcome).toBe('completed');
    expect(executions.count).toBe(1);
  });

  it('counts child cost against the parent cap, but not child steps, while the parent keeps its own totals', async () => {
    const { store, raw } = await world({ usage: { costUsd: 5, onUnknown: 'ignore' } });
    await raw.put('runs', { ...runDoc(), childRunIds: ['child-1'] } as never, { conversationId: CONV });
    await raw.put('runs', { ...runDoc(), id: 'child-1', parentRunId: 'run-1', usage: { ...runDoc().usage, costUsd: 6, steps: 1 } } as never, { conversationId: CONV });
    const budget = createRunBudget({ costUsd: 5, onUnknown: 'ignore' }, true);

    const within = await checkWithChildren(context(), { store } as RunServices, 'run-1', budget, 'check');

    expect(within.ok).toBe(false);
    expect(budget.totals().costUsd).toBe(0);

    // Steps are per run: children with 1000 steps between them must not block a parent with a 150-step cap.
    await raw.put('runs', { ...runDoc(), childRunIds: ['child-2', 'child-3'] } as never, { conversationId: CONV });
    await raw.put('runs', { ...runDoc(), id: 'child-2', parentRunId: 'run-1', usage: { ...runDoc().usage, costUsd: 0, steps: 500 } } as never, { conversationId: CONV });
    await raw.put('runs', { ...runDoc(), id: 'child-3', parentRunId: 'run-1', usage: { ...runDoc().usage, costUsd: 0, steps: 500 } } as never, { conversationId: CONV });
    const stepBudget = createRunBudget({ steps: 150, onUnknown: 'ignore' }, false);
    expect((await checkWithChildren(context(), { store } as RunServices, 'run-1', stepBudget, 'steps')).ok).toBe(true);
  });
});
