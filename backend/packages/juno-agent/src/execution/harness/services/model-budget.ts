/** Model-step budget charging (PH11): charge one observed step and gate the run BEFORE any effect. */
import type { AssistantTurn } from '../../../contracts/index.js';
import type { BudgetCheck } from '../../usage/index.js';
import { chargeActive, chargeCompaction, chargeFailedAttempt } from './model-charges.js';
import { markRunBlocked } from './run-block.js';
import { checkWithChildren, type RunBudget } from './run-budget.js';
import type { RunContext, RunServices } from './run-types.js';

// Pure per-action charges live in model-charges.ts; re-exported so existing import paths hold.
export { chargeActive, chargeCompaction, chargeFailedAttempt } from './model-charges.js';

/** Charge one model step's usage once per stable key; an exhausted budget blocks truthfully. */
export async function chargeModelStep(options: {
  ctx: RunContext;
  services: RunServices;
  runId: string;
  stepIndex: number;
  key?: string;
  budget: RunBudget;
  usage: AssistantTurn['usage'];
  /** Measured inside the model step's own durable action, so a replay never re-reads a clock. */
  durationMs: number;
  /** The run's frozen model id, stored on the run row for the usage ledger; absent on a legacy context. */
  model?: string;
}): Promise<BudgetCheck> {
  const { stepIndex, budget, usage, durationMs } = options;
  const key = options.key ?? ('model:' + String(stepIndex));
  budget.charge(
    key,
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      costKnown: usage.costKnown === true,
      measured: usage.measured !== false,
      activeKnown: typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0,
    },
    durationMs,
  );
  await persistRunUsage(options.ctx, options.services, options.runId, key, budget, options.model);
  const within = await checkWithChildren(options.ctx, options.services, options.runId, budget, key);
  if (!within.ok) await blockOnBudget(options.ctx, options.services, options.runId, key, within.reason);
  return within;
}

/** Charge a failed model attempt outside its durable action, persist, then check before any retry. */
export async function chargeFailedAttemptStep(options: {
  ctx: RunContext;
  services: RunServices;
  runId: string;
  budget: RunBudget;
  key: string;
  durationMs: number;
}): Promise<BudgetCheck> {
  chargeFailedAttempt(options.budget, options.key, options.durationMs);
  await persistRunUsage(options.ctx, options.services, options.runId, options.key, options.budget);
  const within = await checkWithChildren(options.ctx, options.services, options.runId, options.budget, options.key);
  if (!within.ok) await blockOnBudget(options.ctx, options.services, options.runId, options.key, within.reason);
  return within;
}

/** Charge a compaction outside its durable step, persist, then check before the next model call. */
export async function chargeCompactionStep(options: {
  ctx: RunContext;
  services: RunServices;
  runId: string;
  budget: RunBudget;
  key: string;
  context: { [key: string]: unknown };
}): Promise<BudgetCheck> {
  chargeCompaction(options.budget, options.key, options.context);
  await persistRunUsage(options.ctx, options.services, options.runId, options.key, options.budget);
  const within = await checkWithChildren(options.ctx, options.services, options.runId, options.budget, options.key);
  if (!within.ok) await blockOnBudget(options.ctx, options.services, options.runId, options.key, within.reason);
  return within;
}

/** Write the canonical run usage in its own durable step, so a replay re-applies the same totals. */
export async function persistRunUsage(
  ctx: RunContext,
  services: RunServices,
  runId: string,
  key: string,
  budget: RunBudget,
  model?: string,
): Promise<void> {
  await ctx.run(`usage:${key}`, async () => {
    const totals = budget.totals();
    const unknowns = budget.unknowns();
    await services.store.patch('runs', runId, {
      usage: {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        computeSeconds: totals.activeMs / 1000,
        costUsd: totals.costUsd,
        steps: totals.steps,
        // Never present an unknown price as a measured zero.
        costKnown: !unknowns.cost,
        measured: !unknowns.tokens,
      },
      ...(model === undefined ? {} : { model }),
    });
  });
}

/** The parts of one run every out-of-effect charge needs. */
export interface BudgetScope {
  ctx: RunContext;
  services: RunServices;
  runId: string;
  budget: RunBudget;
}

/** Charge one tool effect measured OUTSIDE its fence (wait excluded), then persist+check per call. */
export async function chargeToolCall(scope: BudgetScope, stepIndex: number, callId: string, activeMs: number): Promise<BudgetCheck> {
  chargeActive(scope.budget, 'tool:' + String(stepIndex) + ':' + callId, activeMs);
  await persistRunUsage(scope.ctx, scope.services, scope.runId, 'tools:' + String(stepIndex) + ':' + callId, scope.budget);
  const key = 'tool:' + String(stepIndex) + ':' + callId;
  const within = await checkWithChildren(scope.ctx, scope.services, scope.runId, scope.budget, key);
  if (!within.ok) await blockOnBudget(scope.ctx, scope.services, scope.runId, key, within.reason);
  return within;
}

/**
 * How many more tool calls the step budget allows (each charged tool call is a step). A parallel run of
 * read-only calls is capped by this before any of them starts, so concurrency never lets a call slip
 * past a step limit that sequential execution would have enforced. Time and cost limits cannot be
 * known in advance; they are enforced after the run by budgetSpentAfterTools, as for any batch.
 */
export function toolStepsLeft(scope: BudgetScope): number {
  const limit = scope.budget.limits.steps;
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, limit - scope.budget.totals().steps);
}

/** Check BEFORE one tool effect: a spent budget blocks truthfully without running the effect. */
export async function checkBeforeTool(scope: BudgetScope, stepIndex: number, callId: string): Promise<BudgetCheck> {
  const key = 'tool:' + String(stepIndex) + ':' + callId;
  const within = await checkWithChildren(scope.ctx, scope.services, scope.runId, scope.budget, key);
  if (!within.ok) await blockOnBudget(scope.ctx, scope.services, scope.runId, key, within.reason);
  return within;
}

/** After a tool batch: a spent budget stops the run before another proposal or reply, truthfully. */
export async function budgetSpentAfterTools(scope: BudgetScope, stepIndex: number): Promise<boolean> {
  const within = await checkWithChildren(scope.ctx, scope.services, scope.runId, scope.budget, 'tools:' + String(stepIndex));
  if (within.ok) return false;
  await blockOnBudget(scope.ctx, scope.services, scope.runId, 'tools:' + String(stepIndex), within.reason);
  return true;
}

/** Record a truthful budget-block reason on the run so its tasks stay blocked, not dropped. */
export async function blockOnBudget(
  ctx: RunContext,
  services: RunServices,
  runId: string,
  key: string,
  reason: string,
): Promise<void> {
  await ctx.run('budget-block:' + key, async () => {
    await markRunBlocked(services.store, runId, 'limit', 'run blocked: ' + reason);
  });
}

/** PH10 seam: check BEFORE one configured effect (a completion check) under its stable key. */
export async function checkBeforeEffect(scope: BudgetScope, key: string): Promise<BudgetCheck> {
  const within = await checkWithChildren(scope.ctx, scope.services, scope.runId, scope.budget, key);
  if (!within.ok) await blockOnBudget(scope.ctx, scope.services, scope.runId, key, within.reason);
  return within;
}

/** PH10 seam: charge one configured effect's measured active time after it ran, once per stable key. */
export async function chargeEffect(scope: BudgetScope, key: string, activeMs: number): Promise<BudgetCheck> {
  chargeActive(scope.budget, key, activeMs);
  await persistRunUsage(scope.ctx, scope.services, scope.runId, key, scope.budget);
  const within = await checkWithChildren(scope.ctx, scope.services, scope.runId, scope.budget, key);
  if (!within.ok) await blockOnBudget(scope.ctx, scope.services, scope.runId, key, within.reason);
  return within;
}
