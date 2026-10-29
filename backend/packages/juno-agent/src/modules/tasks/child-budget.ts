/**
 * Pure child-budget snapshot helpers (PH12): freeze the parent remainder at spawn and judge it.
 *
 * Split from childRead so each module keeps its own responsibility and size: this file owns the
 * frozen-budget math on Jason's canonical executionBudget; childRead owns status/result/plan reads.
 */
import { LIMITS } from '../../contracts/index.js';
import type { BudgetLimits } from '../../execution/usage/index.js';
import { childSnapshotFor, parseBudgetSnapshot } from '../../execution/harness/services/run-budget.js';
import type { Store } from '../../contracts/index.js';
import { descendantUsage, type ChildRun } from './childRead.js';


/** Frozen execution budget inherited at spawn: effective limits plus the parent usage they apply to. */
export interface ChildBudgetSnapshot {
  limits: BudgetLimits;
  parentSteps: number;
  parentTokens: number;
  parentCostUsd: number;
  parentActiveSeconds: number;
  /** Parent measured/cost flags at spawn, so unknown spend is never treated as free. */
  parentMeasured?: boolean;
  parentCostKnown?: boolean;
  /** Whether the frozen remainder came from an explicit owner budget (unknown-spend policy). */
  explicitCost?: boolean;
  inheritedAt: string;
}

/**
 * The parent as the child budget reads it: its own usage plus the spend of every descendant already
 * started (live rows included). Children take their frozen remainder from this view, so siblings cannot
 * each take all of it. Each run's own row holds only its own usage, so the walk sums the whole subtree.
 */
export async function budgetViewWithChildren(store: Store, parent: ChildRun, parentRunId: string): Promise<ChildRun> {
  return { ...parent, usage: await descendantUsage(store, parentRunId, parent.usage) };
}

/**
 * Freeze the child budget at spawn from the parent's canonical executionBudget (Jason's persisted
 * { limits, explicitCost }, validated by his parse guard): the REMAINING limits after the parent
 * spend via his childSnapshotFor (cache tokens included), plus the parent usage and unknown
 * measured/cost flags at spawn. Never reread global settings here. Legacy parents without a
 * snapshot contribute no explicit limits; the static ceiling backstop still applies.
 */
export function inheritBudgetSnapshot(parent: ChildRun): ChildBudgetSnapshot {
  const parsed = parseBudgetSnapshot(parent.executionBudget);
  const remaining = parsed === undefined ? undefined : childSnapshotFor(parsed, parent.usage);
  return {
    limits: remaining === undefined ? {} : { ...remaining.limits },
    explicitCost: remaining?.explicitCost,
    parentSteps: parent.usage.steps,
    parentTokens: parent.usage.inputTokens + parent.usage.outputTokens + (parent.usage.cacheReadTokens ?? 0) + (parent.usage.cacheWriteTokens ?? 0),
    parentCostUsd: parent.usage.costUsd,
    parentActiveSeconds: parent.usage.computeSeconds,
    parentMeasured: parent.usage.measured,
    parentCostKnown: parent.usage.costKnown,
    inheritedAt: new Date().toISOString(),
  };
}

/**
 * True when the frozen remainder leaves nothing to run on: any remaining limit at zero, the static
 * ceiling spent, or unknown spend under an explicit blocking budget (mirrors checkBudget's
 * blockUnknown rule, using the flags frozen at spawn so unknowns are never treated as free).
 */
/**
 * Present-but-unparseable executionBudget: data corruption, never a legacy row. Legacy rows carry no
 * snapshot field at all and fall back to the static ceiling; a present field that fails Jason's
 * parse guard fails closed (the caller refuses) instead of running unbounded.
 */
export function isExecutionBudgetCorrupt(parent: ChildRun): boolean {
  return parent.executionBudget !== undefined && parseBudgetSnapshot(parent.executionBudget) === undefined;
}
export function isChildBudgetSpent(snapshot: ChildBudgetSnapshot, parent: ChildRun): boolean {
  const limits = snapshot.limits;
  if (limits.steps !== undefined && limits.steps <= 0) return true;
  if (limits.tokens !== undefined && limits.tokens <= 0) return true;
  if (limits.costUsd !== undefined && limits.costUsd <= 0) return true;
  if (limits.activeSeconds !== undefined && limits.activeSeconds <= 0) return true;
  const explicit = limits.costUsd !== undefined || limits.tokens !== undefined;
  const blockUnknown = limits.onUnknown ?? (explicit ? 'block' : 'ignore');
  if (blockUnknown === 'block') {
    if (limits.tokens !== undefined && snapshot.parentMeasured === false) return true;
    if (limits.costUsd !== undefined && snapshot.parentCostKnown === false) return true;
  }
  if (parent.usage.steps >= LIMITS.run.maxSteps || parent.usage.costUsd >= LIMITS.run.maxCostUsd) return true;
  return false;
}
