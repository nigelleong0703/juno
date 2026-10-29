/** Frozen budget snapshots a run persists and its children inherit (PH11). Pure: no durable steps. */
import type { Run, RunUsage } from '@agent-desktop/public-contracts';
import type { BudgetLimits } from '../../usage/index.js';

/** A run's frozen budget snapshot: effective limits plus the explicit flag at freeze time. */
export interface BudgetSnapshot {
  limits: BudgetLimits;
  explicitCost: boolean;
}

/** A run doc carrying its frozen snapshot for children (private field, written once via put). */
export type RunWithBudgetSnapshot = Run & { executionBudget?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Trust a stored snapshot only when every field parses; undefined means absent or unclaimed. */
export function parseBudgetSnapshot(value: unknown): BudgetSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (!isRecord(value['limits']) || typeof value['explicitCost'] !== 'boolean') return undefined;
  const onUnknown: unknown = value['limits']['onUnknown'];
  if (onUnknown !== undefined && onUnknown !== 'block' && onUnknown !== 'ignore') return undefined;
  const limits: BudgetLimits = {};
  for (const key of ['steps', 'tokens', 'activeSeconds', 'costUsd'] as const) {
    const field: unknown = value['limits'][key];
    if (field === undefined) continue;
    const limit = readLimit(field);
    if (limit === undefined) return undefined;
    Reflect.set(limits, key, limit);
  }
  if (onUnknown === 'block' || onUnknown === 'ignore') limits.onUnknown = onUnknown;
  return { limits, explicitCost: value['explicitCost'] };
}

/** A child row's spawn-frozen budget: the snapshot plus the parent unknown-spend flags at spawn. */
export interface ChildFrozenBudget {
  snapshot: BudgetSnapshot;
  /** The parent's measured/cost flags frozen at spawn; absent on rows written before they existed. */
  parentMeasured?: boolean;
  parentCostKnown?: boolean;
}

/**
 * Parse a child row's spawn-frozen budget (the tasks module stores { limits, explicitCost, ... } at
 * spawn): undefined when the field is absent, 'malformed' when it claims a snapshot that does not
 * parse — including any present flag that is not a boolean — so the caller can fail closed instead
 * of falling back to changed settings. Only a present flag is read; absent flags are not invented.
 */
export function parseChildFrozenBudget(value: unknown): ChildFrozenBudget | 'malformed' | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isRecord(value['limits'])) return 'malformed';
  const explicit: unknown = value['explicitCost'];
  if (explicit !== undefined && typeof explicit !== 'boolean') return 'malformed';
  const snapshot = parseBudgetSnapshot({ limits: value['limits'], explicitCost: explicit === true });
  if (snapshot === undefined) return 'malformed';
  const parentMeasured: unknown = value['parentMeasured'];
  const parentCostKnown: unknown = value['parentCostKnown'];
  if (parentMeasured !== undefined && typeof parentMeasured !== 'boolean') return 'malformed';
  if (parentCostKnown !== undefined && typeof parentCostKnown !== 'boolean') return 'malformed';
  return {
    snapshot,
    ...(parentMeasured === undefined ? {} : { parentMeasured }),
    ...(parentCostKnown === undefined ? {} : { parentCostKnown }),
  };
}

/** The frozen snapshot of one live budget, for persistence onto its run doc. */
export function snapshotOf(budget: { limits: BudgetLimits; explicitCost: boolean }): BudgetSnapshot {
  return { limits: { ...budget.limits }, explicitCost: budget.explicitCost };
}

/** Read the snapshot a stored run carries, if it parses. */
export function snapshotOfRun(run: unknown): BudgetSnapshot | undefined {
  const field: unknown = isRecord(run) ? run['executionBudget'] : undefined;
  return parseBudgetSnapshot(field);
}

/**
 * The bounded budget a child inherits: the parent frozen limits minus what the parent already spent
 * (cache tokens included), so a child never re-opens the parent's whole budget for itself. Each
 * spent figure must parse: a stored parent usage that is non-finite or negative is corrupt, and
 * the corresponding inherited limit is granted as zero (fail closed) instead of propagating NaN
 * past the ceiling or presenting corrupt spend as free. Absent figures stay absent (zero spend).
 */
export function childSnapshotFor(snapshot: BudgetSnapshot, usage: RunUsage): BudgetSnapshot {
  const remaining = (limit: number | undefined, used: unknown): number | undefined => {
    if (limit === undefined) return undefined;
    if (used === undefined) return limit;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return 0;
    return Math.max(0, limit - used);
  };
  const tokens = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  const tokensCorrupt = tokens.some((part) => part !== undefined && (typeof part !== 'number' || !Number.isFinite(part) || part < 0));
  const limits: BudgetLimits = {
    ...(snapshot.limits.steps === undefined ? {} : { steps: remaining(snapshot.limits.steps, usage.steps) }),
    ...(snapshot.limits.tokens === undefined ? {} : { tokens: tokensCorrupt ? 0 : remaining(snapshot.limits.tokens, tokens.reduce<number>((sum, part) => sum + (part ?? 0), 0)) }),
    ...(snapshot.limits.activeSeconds === undefined ? {} : { activeSeconds: remaining(snapshot.limits.activeSeconds, usage.computeSeconds) }),
    ...(snapshot.limits.costUsd === undefined ? {} : { costUsd: remaining(snapshot.limits.costUsd, usage.costUsd) }),
    ...(snapshot.limits.onUnknown === undefined ? {} : { onUnknown: snapshot.limits.onUnknown }),
  };
  return { limits, explicitCost: snapshot.explicitCost };
}
