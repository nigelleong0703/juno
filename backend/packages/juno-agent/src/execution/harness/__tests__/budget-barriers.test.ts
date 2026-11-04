/**
 * PH11 budget barriers through the real Run loop.
 *
 * Every model retry, compaction and tool effect observes the frozen account budget before and after
 * it runs: a compaction that spends the budget blocks before the next model call, a failed attempt
 * that spends it blocks without a retry, and a first tool that spends it stops the second tool.
 * Tool usage journal keys carry the step and the call id, so the canonical run usage is exact.
 * A child run inherits its parent validated snapshot instead of re-reading changed settings.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { DurablePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { LIMITS, type AssistantTurn, type Brain, type BrainContext, type Doc, type Store, type Tool, type ToolRegistry, type ToolResult, type WakeEvent } from '../../../contracts/index.js';
import { appSettingsSchema, type Run } from '@agent-desktop/public-contracts';
import { requestScopedStore } from '../../../owner-context.js';
import { ProviderFailureError } from '../../brain/model-failure.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import { runFencedTool, type ToolRunContext } from '../services/replay.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';
import { createRunBudget, loadRunBudget, parseBudgetSnapshot, persistBudgetSnapshot, snapshotOfRun, type RunWithBudgetSnapshot } from '../services/run-budget.js';

const AT = '2026-10-08T00:00:00.000Z';
const OWNER = 'owner-barriers';
const AGENT = 'agent-barriers';
const CONV = 'conv-barriers';
const USAGE = { inputTokens: 5, outputTokens: 2, costUsd: 0, costKnown: true };

function wake(): WakeEvent {
  return {
    id: 'wake-1', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'go', addressed: 'direct' }, at: AT, status: 'accepted',
  };
}
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake()] };

function runDoc(): Run {
  return {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'barriers', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  };
}

/** A durable context that executes each step directly and rejects a repeated step name. */
function directContext(): RunContext {
  const used = new Set<string>();
  let seq = 0;
  return {
    rand: { uuidv4: () => 'id-' + String(seq++) },
    run: <T>(name: string, action: () => Promise<T>): DurablePromise<T> => {
      if (used.has(name)) throw new Error('duplicate durable step: ' + name);
      used.add(name);
      return DurablePromise.resolve(action());
    },
    awakeable: <T>() => ({ id: 'awake-' + String(seq++), promise: DurablePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => DurablePromise.resolve<WakeEvent[]>([]),
  };
}

function countingTool(name: string, count: { n: number }): Tool {
  return {
    name, description: name, parameters: { type: 'object' }, replay: 'safe', sideEffect: false,
    async execute() {
      count.n += 1;
      return { content: [{ type: 'text', text: name + ' ran' }] };
    },
  };
}

function registry(tools: Tool[]): ToolRegistry {
  return { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
}

async function world(usage?: { steps?: number; activeSeconds?: number; costUsd?: number }): Promise<{ store: Store; raw: ReturnType<typeof createMemoryStore> }> {
  const raw = createMemoryStore();
  await raw.put('runs', runDoc(), { conversationId: CONV });
  if (usage !== undefined) {
    await raw.put('settings', {
      ...appSettingsSchema.parse({
        general: { launchAtLogin: false, language: 'en' },
        appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
        notifications: [],
        usage,
        yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
        connections: { serverUrl: '', modelProviders: [] },
        privacy: { dataRetentionDays: 90, trainingOptIn: false },
        advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
      }),
      id: 'app-settings-' + OWNER,
    });
  }
  return { store: requestScopedStore(raw), raw };
}

/** Minimal services for budget helper tests: only the store is exercised. */
function budgetServices(store: Store): RunServices {
  const brain: Brain = {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: 'x', agentId: 'x' };
    },
    async step(): Promise<AssistantTurn> {
      return { text: '', toolCalls: [], usage: USAGE, stopReason: 'stop' };
    },
    shouldCompact: () => false,
    async compact(ctx: BrainContext): Promise<BrainContext> {
      return ctx;
    },
  };
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry([]) };
}

function servicesFor(store: Store, brain: Brain, tools: Tool[]): RunServices {
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registry(tools) };
}

/** A model with scripted turns that records how often the loop actually called it. */
class ScriptedTurns implements Brain {
  calls = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async buildContext(): Promise<BrainContext> {
    return { sessionKey: input.sessionKey, agentId: AGENT };
  }
  async step(): Promise<AssistantTurn> {
    const turn = this.turns[Math.min(this.calls, this.turns.length - 1)];
    this.calls += 1;
    if (!turn) throw new Error('no scripted turn');
    return turn;
  }
  shouldCompact(): boolean {
    return false;
  }
  async compact(ctx: BrainContext): Promise<BrainContext> {
    return ctx;
  }
}

function toolTurn(): AssistantTurn {
  return {
    text: '', usage: USAGE, stopReason: 'tool_calls',
    toolCalls: [{ id: 'c1', name: 'alpha', arguments: {} }, { id: 'c2', name: 'beta', arguments: {} }],
  };
}

function finalTurn(): AssistantTurn {
  return { text: 'done', toolCalls: [], usage: USAGE, stopReason: 'stop' };
}

describe('PH11 budget barriers', () => {
  it('blocks before the next model call when a compaction spends the budget', async () => {
    const { store, raw } = await world({ activeSeconds: 1 });
    const alpha = { n: 0 };
    const beta = { n: 0 };
    const inner = new ScriptedTurns([toolTurn(), finalTurn()]);
    let builds = 0;
    const brain: Brain = {
      buildContext: async () => {
        builds += 1;
        return inner.buildContext();
      },
      step: () => inner.step(),
      shouldCompact: () => builds > 0,
      compact: async (ctx) => ({ ...ctx, compactionMetrics: { durationMs: 5000 } }),
    };
    const outcome = await runLoop(directContext(), servicesFor(store, brain, [countingTool('alpha', alpha), countingTool('beta', beta)]), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    expect(outcome).toBe('blocked');
    expect(inner.calls).toBe(1);
    expect(alpha.n).toBe(1);
    expect(beta.n).toBe(1);
    expect((await raw.get('runs', 'run-1'))?.error).toContain('active time');
    expect((await raw.get('runs', 'run-1'))?.usage?.computeSeconds).toBeGreaterThanOrEqual(5);
  });

  it('blocks without a retry when a failed attempt spends the budget', async () => {
    const { store, raw } = await world({ steps: 1 });
    let calls = 0;
    const brain: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(): Promise<AssistantTurn> {
        calls += 1;
        throw new ProviderFailureError({ kind: 'transient', code: 'transient', message: 'provider hiccup' });
      },
      shouldCompact: () => false,
      async compact(ctx): Promise<BrainContext> {
        return ctx;
      },
    };
    const outcome = await runLoop(directContext(), servicesFor(store, brain, []), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    expect(outcome).toBe('blocked');
    expect(calls).toBe(1);
    expect((await raw.get('runs', 'run-1'))?.error).toContain('step budget');
  });

  it('runs two tools under distinct journal keys with exact canonical usage', async () => {
    const { store, raw } = await world();
    const alpha = { n: 0 };
    const beta = { n: 0 };
    const brain = new ScriptedTurns([toolTurn(), finalTurn()]);
    const outcome = await runLoop(directContext(), servicesFor(store, brain, [countingTool('alpha', alpha), countingTool('beta', beta)]), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    expect(outcome).toBe('completed');
    expect(alpha.n).toBe(1);
    expect(beta.n).toBe(1);
    expect((await raw.get('runs', 'run-1'))?.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, steps: 4 });
  });

  it('stops the second tool when the first tool spends the budget', async () => {
    const { store, raw } = await world({ steps: 2 });
    const alpha = { n: 0 };
    const beta = { n: 0 };
    const brain = new ScriptedTurns([toolTurn(), finalTurn()]);
    const outcome = await runLoop(directContext(), servicesFor(store, brain, [countingTool('alpha', alpha), countingTool('beta', beta)]), input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED);
    expect(outcome).toBe('blocked');
    expect(brain.calls).toBe(1);
    expect(alpha.n).toBe(1);
    expect(beta.n).toBe(0);
    expect((await raw.get('runs', 'run-1'))?.error).toContain('step budget');
    expect((await raw.get('runs', 'run-1'))?.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, steps: 2 });
  });

  it('counts a replayed charge once, including active time', async () => {
    const budget = createRunBudget({ steps: 2 }, false);
    budget.charge('tool:0:c1', { inputTokens: 5, outputTokens: 2, costUsd: 0, costKnown: true, measured: true }, 120);
    const once = budget.totals();
    budget.charge('tool:0:c1', { inputTokens: 9, outputTokens: 9, costUsd: 9, costKnown: true, measured: true }, 999);
    expect(budget.totals()).toEqual(once);
    expect(once.activeMs).toBe(120);
    expect(once.steps).toBe(1);
  });

  it('persists the frozen snapshot once for children to inherit', async () => {
    const { store, raw } = await world({ steps: 5 });
    const root = await loadRunBudget(directContext(), budgetServices(store), OWNER);
    await persistBudgetSnapshot(directContext(), budgetServices(store), 'run-1', root);
    const stored = await raw.get('runs', 'run-1');
    expect(stored).not.toBeNull();
    expect(snapshotOfRun(stored)).toMatchObject({ limits: { steps: 5 }, explicitCost: false });
  });

  it('lets a child inherit the frozen snapshot despite changed settings', async () => {
    const { store, raw } = await world({ steps: 5 });
    const root = await loadRunBudget(directContext(), budgetServices(store), OWNER);
    await persistBudgetSnapshot(directContext(), budgetServices(store), 'run-1', root);
    await raw.patch('settings', 'app-settings-' + OWNER, { usage: { steps: 100 } });
    const child = await loadRunBudget(directContext(), budgetServices(store), OWNER, { parentRunId: 'run-1' });
    expect(child.limits.steps).toBe(5);
  });
});
describe('PH11 child budget inheritance', () => {
  it('bounds the child by what the parent had left', async () => {
    const { store, raw } = await world({ steps: 5 });
    const root = await loadRunBudget(directContext(), budgetServices(store), OWNER);
    await persistBudgetSnapshot(directContext(), budgetServices(store), 'run-1', root);
    await raw.patch('runs', 'run-1', { usage: { inputTokens: 4, outputTokens: 2, computeSeconds: 0, costUsd: 0, steps: 2 } });
    const child = await loadRunBudget(directContext(), budgetServices(store), OWNER, { parentRunId: 'run-1' });
    expect(child.limits.steps).toBe(3);
  });

  it('falls back to current settings when the parent predates snapshots', async () => {
    const { store } = await world({ steps: 7 });
    const child = await loadRunBudget(directContext(), budgetServices(store), OWNER, { parentRunId: 'run-1' });
    expect(child.limits.steps).toBe(7);
  });

  it('rejects malformed stored snapshots', async () => {
    expect(parseBudgetSnapshot(undefined)).toBeUndefined();
    expect(parseBudgetSnapshot({ limits: { steps: 2 }, explicitCost: false })).toEqual({ limits: { steps: 2 }, explicitCost: false });
    expect(parseBudgetSnapshot({ limits: { steps: -1 }, explicitCost: false })).toBeUndefined();
    expect(parseBudgetSnapshot({ limits: { onUnknown: 'sometimes' }, explicitCost: false })).toBeUndefined();
    expect(parseBudgetSnapshot({ limits: { steps: 2 } })).toBeUndefined();
    expect(parseBudgetSnapshot({ limits: 'none', explicitCost: false })).toBeUndefined();
  });

  it('keeps an explicit cost budget truthful on unknown spend for the child', async () => {
    const { store } = await world({ costUsd: 5 });
    const root = await loadRunBudget(directContext(), budgetServices(store), OWNER);
    await persistBudgetSnapshot(directContext(), budgetServices(store), 'run-1', root);
    const child = await loadRunBudget(directContext(), budgetServices(store), OWNER, { parentRunId: 'run-1' });
    child.charge('model:0', { inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: false, measured: false }, 0);
    expect(child.check().ok).toBe(false);
  });
});

describe('PH11 fence cached duration', () => {
  it('reuses the cached effect duration without re-running the effect', async () => {
    const raw = createMemoryStore();
    const store = requestScopedStore(raw);
    const plain: Doc<'steps'> = {
      id: 'stp-fence', runId: 'run-1', index: 0, kind: 'mcp', verb: 'Executed', target: 'effect',
      status: 'running', startedAt: AT, durationMs: 0,
    };
    await raw.put('steps', plain, { runId: 'run-1' });
    const current = await raw.get('steps', 'stp-fence');
    expect(current).not.toBeNull();
    if (current === null) throw new Error('seed step missing');
    const fenced: Doc<'steps'> & { execution: unknown } = {
      ...current,
      execution: {
        fencedAt: AT,
        result: { content: [{ type: 'text', text: 'cached effect' }], runtimeActiveMs: 1500 },
      },
    };
    await raw.put('steps', fenced, { runId: 'run-1' });
    let executions = 0;
    const action = async (): Promise<ToolResult> => {
      executions += 1;
      return { content: [{ type: 'text', text: 'must not run' }] };
    };
    const fence: ToolRunContext = {
      rand: { uuidv4: () => 'fence-1' },
      run: <T>(name: string, inner: () => Promise<T>): DurablePromise<T> => DurablePromise.resolve(inner()),
    };
    const cached = await runFencedTool(fence, store, plain, 'effect', action);
    expect(executions).toBe(0);
    expect(cached.interrupted).toBe(false);
    expect(cached.result.content).toEqual([{ type: 'text', text: 'cached effect' }]);
    expect(cached.result.runtimeActiveMs).toBe(1500);
  });
});

describe('PH11 own snapshot precedence', () => {
  it('prefers the own frozen snapshot over changed settings', async () => {
    const { store, raw } = await world({ steps: 5 });
    const root = await loadRunBudget(directContext(), budgetServices(store), OWNER);
    await persistBudgetSnapshot(directContext(), budgetServices(store), 'run-1', root);
    await raw.patch('settings', 'app-settings-' + OWNER, { usage: { steps: 100 } });
    const same = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-1' });
    expect(same.limits.steps).toBe(5);
  });

  it('fails closed when the own frozen snapshot is malformed', async () => {
    const { store, raw } = await world({ steps: 5 });
    const root = await loadRunBudget(directContext(), budgetServices(store), OWNER);
    await persistBudgetSnapshot(directContext(), budgetServices(store), 'run-1', root);
    const current = await raw.get('runs', 'run-1');
    expect(current).not.toBeNull();
    if (current === null) throw new Error('seed run missing');
    const corrupt: RunWithBudgetSnapshot = { ...current, executionBudget: { bogus: 1 } };
    await raw.put('runs', corrupt, { conversationId: CONV });
    await raw.patch('settings', 'app-settings-' + OWNER, { usage: { steps: 100 } });
    const fallback = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-1' });
    expect(fallback.limits.steps).toBe(0);
    expect(fallback.check().ok).toBe(false);
  });
});

describe('PH11 real spawn freeze', () => {
  it('consumes the child spawn-frozen snapshot instead of re-deriving from fresh parent usage', async () => {
    const { store, raw } = await world({ steps: 100 });
    const root = await loadRunBudget(directContext(), budgetServices(store), OWNER);
    await persistBudgetSnapshot(directContext(), budgetServices(store), 'run-1', root);
    // The parent keeps spending after the spawn froze the child's remaining budget.
    await raw.patch('runs', 'run-1', { usage: { inputTokens: 40, outputTokens: 30, computeSeconds: 0, costUsd: 0, steps: 9 } });
    const child: Run & { parentRunId?: string; budgetSnapshot?: unknown } = {
      ...runDoc(), id: 'run-child-1', parentRunId: 'run-1',
      budgetSnapshot: { limits: { steps: 3 }, parentSteps: 2, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0, inheritedAt: AT },
    };
    await raw.put('runs', child, { conversationId: CONV });
    const subagentBudget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-child-1', parentRunId: 'run-1' });
    expect(subagentBudget.limits.steps).toBe(3);
  });

  it('fails closed when the parent snapshot is malformed instead of rereading settings', async () => {
    const { store, raw } = await world({ steps: 100 });
    const current = await raw.get('runs', 'run-1');
    expect(current).not.toBeNull();
    if (current === null) throw new Error('seed run missing');
    const corrupt: RunWithBudgetSnapshot = { ...current, executionBudget: { bogus: 1 } };
    await raw.put('runs', corrupt, { conversationId: CONV });
    const child = await loadRunBudget(directContext(), budgetServices(store), OWNER, { parentRunId: 'run-1' });
    expect(child.limits.steps).toBe(0);
    expect(child.check().ok).toBe(false);
  });

  it('fails closed when the spawn-frozen child snapshot is malformed', async () => {
    const { store, raw } = await world({ steps: 100 });
    const child: Run & { parentRunId?: string; budgetSnapshot?: unknown } = {
      ...runDoc(), id: 'run-child-2', parentRunId: 'run-1', budgetSnapshot: { limits: 'none' },
    };
    await raw.put('runs', child, { conversationId: CONV });
    const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-child-2', parentRunId: 'run-1' });
    expect(budget.limits.steps).toBe(0);
    expect(budget.check().ok).toBe(false);
  });

  it('fails closed when frozen parent spend was unknown under explicit child limits', async () => {
    const { store, raw } = await world({ steps: 100 });
    // Each unknown flag is paired with the limit it governs: unmeasured tokens block a token
    // limit, unknown price blocks a cost limit. An unknown flag irrelevant to every frozen
    // limit no longer fails closed (PH-child-unknown relevant-flag semantics).
    const frozen = (id: string, limits: { steps: number; tokens?: number; costUsd?: number }, flags: { parentMeasured?: boolean; parentCostKnown?: boolean }): Run & { parentRunId?: string; budgetSnapshot?: unknown } => ({
      ...runDoc(), id, parentRunId: 'run-1',
      budgetSnapshot: {
        limits, parentSteps: 2, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0,
        ...flags, inheritedAt: AT,
      },
    });
    await raw.put('runs', frozen('run-child-unmeasured', { steps: 5, tokens: 100 }, { parentMeasured: false }), { conversationId: CONV });
    await raw.put('runs', frozen('run-child-unpriced', { steps: 5, costUsd: 1 }, { parentCostKnown: false }), { conversationId: CONV });
    for (const id of ['run-child-unmeasured', 'run-child-unpriced']) {
      const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: id, parentRunId: 'run-1' });
      expect(budget.check().ok).toBe(false);
    }
  });

  it('fails closed on malformed frozen flags instead of coercing them', async () => {
    const { store, raw } = await world({ steps: 100 });
    const child = (id: string, extra: Record<string, unknown>): Run & { parentRunId?: string; budgetSnapshot?: unknown } => ({
      ...runDoc(), id, parentRunId: 'run-1',
      budgetSnapshot: { limits: { steps: 5 }, parentSteps: 0, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0, ...extra, inheritedAt: AT },
    });
    await raw.put('runs', child('run-child-garbage', { explicitCost: 'garbage' }), { conversationId: CONV });
    await raw.put('runs', child('run-child-flagged', { parentMeasured: 'yes' }), { conversationId: CONV });
    for (const id of ['run-child-garbage', 'run-child-flagged']) {
      const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: id, parentRunId: 'run-1' });
      expect(budget.check().ok).toBe(false);
    }
  });

  it('keeps the static cost ceiling for a legacy child with empty frozen limits', async () => {
    const { store, raw } = await world({ steps: 100 });
    const child: Run & { parentRunId?: string; budgetSnapshot?: unknown } = {
      ...runDoc(), id: 'run-child-legacy', parentRunId: 'run-1',
      budgetSnapshot: { limits: {}, parentSteps: 0, parentTokens: 0, parentCostUsd: 0, parentActiveSeconds: 0, inheritedAt: AT },
    };
    await raw.put('runs', child, { conversationId: CONV });
    const budget = await loadRunBudget(directContext(), budgetServices(store), OWNER, { runId: 'run-child-legacy', parentRunId: 'run-1' });
    expect(budget.limits.costUsd).toBe(LIMITS.run.maxCostUsd);
    expect(budget.check().ok).toBe(true);
  });
});
