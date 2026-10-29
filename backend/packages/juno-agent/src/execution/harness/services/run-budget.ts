/** Per-run usage and budget authority (PH11): one account-GLOBAL freeze, one charge per stable key. */
import { LIMITS } from '../../../contracts/index.js';
import { markRunBlocked } from './run-block.js';
import {
  addActiveMs,
  checkBudget,
  createUsageState,
  observeUsage,
  parseBudgetLimits,
  type BudgetCheck,
  type BudgetLimits,
  type UsageSample,
  type UsageState,
  type UsageTotals,
} from '../../usage/index.js';
import type { RunContext, RunServices } from './run-types.js';
import type { RunUsage } from '@agent-desktop/public-contracts';
import { descendantUsage, emptyUsage } from '../../../modules/tasks/childRead.js';
import { childSnapshotFor, parseChildFrozenBudget, snapshotOf, snapshotOfRun, type ChildFrozenBudget, type RunWithBudgetSnapshot } from './budget-snapshot.js';

// The snapshot parsers live beside the snapshot types; these re-exports keep existing import paths.
export { childSnapshotFor, parseBudgetSnapshot, parseChildFrozenBudget, snapshotOf, snapshotOfRun } from './budget-snapshot.js';
export type { BudgetSnapshot, RunWithBudgetSnapshot } from './budget-snapshot.js';

/** Owner settings row id: the owner is part of the id, so budgets stay per account. */
function settingsId(ownerId: string): string {
  return 'app-settings-' + ownerId;
}

export interface RunBudget {
  readonly limits: BudgetLimits;
  /** True when the owner configured an explicit cost budget (its onUnknown policy applies). */
  readonly explicitCost: boolean;
  charge(key: string, sample: UsageSample, activeMs: number): void;
  /** The spend of this run's descendants; only its cost is counted by check(), and never by totals(). */
  inheritChildren(spent: RunUsage): void;
  /** A durable step name for one child-spend read: unique per check in this run, same order on replay. */
  nextSpendStep(key: string): string;
  check(): BudgetCheck;
  totals(): UsageTotals;
  /** Whether any charge reported an unknown price / unmeasured counters, plus the counted actions. */
  unknowns(): { cost: boolean; tokens: boolean; active: boolean; actions: number };
}

/**
 * The state with descendant COST added on top: a parent's USD cap covers what its children spent. Steps,
 * tokens and active time stay per run: children run in parallel and each is bounded by its own snapshot,
 * so adding them here would block a parent with several children early and double count active time.
 */
function withChildCost(state: UsageState, spent: RunUsage): UsageState {
  return {
    ...state,
    totals: { ...state.totals, costUsd: state.totals.costUsd + spent.costUsd },
    unknownCost: state.unknownCost || spent.costKnown === false,
  };
}

export function createRunBudget(limits: BudgetLimits, explicitCost: boolean): RunBudget {
  // Freeze the exposed limits: external mutation of the passed object must not move inheritance
  // or enforcement, which both read from this frozen copy.
  const frozen = Object.freeze({ ...limits });
  let state = createUsageState(frozen);
  let children: RunUsage | undefined;
  let spendReads = 0;
  return {
    limits: frozen,
    explicitCost,
    charge: (key, sample, activeMs) => {
      // observeUsage dedups by key; the early return above keeps active time replay-safe too.
      if (state.counted.has(key)) return;
      state = addActiveMs(observeUsage(state, sample, key), activeMs);
    },
    inheritChildren: (spent) => {
      children = spent;
    },
    nextSpendStep: (key) => {
      spendReads += 1;
      return 'child-spend:' + key + '#' + String(spendReads);
    },
    check: () => checkBudget(children === undefined ? state : withChildCost(state, children)),
    // Totals leave as a copy: mutating the returned object must not move the authority.
    totals: () => ({ ...state.totals }),
    unknowns: () => ({ cost: state.unknownCost, tokens: state.unknownTokens, active: state.unknownActive, actions: state.counted.size }),
  };
}

function effectiveLimits(explicit: BudgetLimits): BudgetLimits {
  const cost = explicit.costUsd;
  // Blocking on unknown is opt-in, and it follows ANY explicit budget (cost or tokens), never the
  const explicitBudget = cost !== undefined || explicit.tokens !== undefined;
  return {
    ...explicit,
    // The static caps are hard ceilings over known spend and active time; an explicit budget can only tighten them.
    costUsd: cost === undefined ? LIMITS.run.maxCostUsd : Math.min(cost, LIMITS.run.maxCostUsd),
    activeSeconds: explicit.activeSeconds === undefined ? LIMITS.run.maxActiveSeconds : Math.min(explicit.activeSeconds, LIMITS.run.maxActiveSeconds),
    onUnknown: explicit.onUnknown ?? (explicitBudget ? 'block' : 'ignore'),
  };
}

/** Fail closed: a frozen field that claims a snapshot but does not parse blocks the run. */
function failClosedBudget(): RunBudget {
  return createRunBudget({ steps: 0 }, false);
}

/** The budget a spawn-frozen child row stores: unknown parent spend fails closed only when the
 * frozen onUnknown policy says block AND the unknown is relevant to a frozen limit (unmeasured
 * tokens under a token limit, unknown price under a cost limit) — mirroring the spawn gate and
 * checkBudget, so a frozen 'ignore' child runs under the static known-spend ceiling instead of
 * stopping at zero steps. Absent flags are not invented as unknown: rows that predate the flags
 * (or never claimed parent spend) fall through to the frozen limits. Malformed snapshots still
 * fail closed at the caller, and a legacy child whose frozen limits carry no explicit price
 * keeps the static cost ceiling. */
function childFrozenBudget(frozen: ChildFrozenBudget): RunBudget {
  const limits = frozen.snapshot.limits;
  const explicit = limits.tokens !== undefined || limits.costUsd !== undefined;
  const blockUnknown = limits.onUnknown ?? (explicit ? 'block' : 'ignore');
  const effective = effectiveLimits(limits);
  if (blockUnknown === 'block') {
    if (limits.tokens !== undefined && frozen.parentMeasured === false) return failClosedBudget();
    if (limits.costUsd !== undefined && frozen.parentCostKnown === false) return failClosedBudget();
  }
  return createRunBudget(effective, frozen.snapshot.explicitCost);
}

/**
 * Freeze the owner budget for the whole run (never re-read mid-run). A child consumes the frozen
 * fields that are already stored — its own spawn snapshot first, then its parent's snapshot minus
 * the parent spend — and a claimed frozen field that does not parse fails closed instead of falling
 * back to settings. The settings read stays FIRST in the durable sequence so an in-flight run's
 * journal replays in the recorded order; its value is only used for a legacy run without snapshots.
 */
export async function loadRunBudget(
  ctx: RunContext,
  services: RunServices,
  ownerId: string,
  inherit?: { runId?: string; parentRunId?: string },
): Promise<RunBudget> {
  const settings = await ctx.run('budget', () => services.store.get('settings', settingsId(ownerId)));
  const runId = inherit?.runId;
  if (runId !== undefined) {
    const own = await ctx.run('budget-own', () => services.store.get('runs', runId));
    if (own !== null) {
      const ownSnapshot = snapshotOfRun(own);
      if (ownSnapshot !== undefined) return createRunBudget(ownSnapshot.limits, ownSnapshot.explicitCost);
      if (Reflect.get(own, 'executionBudget') !== undefined) return failClosedBudget();
      const frozen = parseChildFrozenBudget(Reflect.get(own, 'budgetSnapshot'));
      if (frozen === 'malformed') return failClosedBudget();
      if (frozen !== undefined) return childFrozenBudget(frozen);
    }
  }
  const parentRunId = inherit?.parentRunId;
  if (parentRunId !== undefined) {
    const parent = await ctx.run('budget-inherit', () => services.store.get('runs', parentRunId));
    if (parent === null) return failClosedBudget();
    const parentSnapshot = snapshotOfRun(parent);
    if (parentSnapshot !== undefined) {
      const child = childSnapshotFor(parentSnapshot, parent.usage);
      return createRunBudget(child.limits, child.explicitCost);
    }
    if (Reflect.get(parent, 'executionBudget') !== undefined) return failClosedBudget();
  }
  const explicit = parseBudgetLimits(settings);
  return createRunBudget(effectiveLimits(explicit), explicit.costUsd !== undefined);
}

/**
 * Persist the frozen snapshot once, in its own durable step, so a replay re-applies it. Children get
 * their own copy, so their combined spend is never claimed as one shared pool.
 */
export async function persistBudgetSnapshot(ctx: RunContext, services: RunServices, runId: string, budget: RunBudget): Promise<void> {
  await ctx.run('budget-snapshot', async () => {
    const current = await services.store.get('runs', runId);
    if (current === null) return;
    const next: RunWithBudgetSnapshot = { ...current, executionBudget: snapshotOf(budget) };
    await services.store.put('runs', next);
  });
}

/** Read the run's descendant spend durably, then check: a parent's cost cap covers its children's spend. */
export async function checkWithChildren(ctx: RunContext, services: RunServices, runId: string, budget: RunBudget, key: string): Promise<BudgetCheck> {
  budget.inheritChildren(await ctx.run(budget.nextSpendStep(key), () => descendantUsage(services.store, runId, emptyUsage())));
  return budget.check();
}

export async function preflightBudget(
  ctx: RunContext,
  services: RunServices,
  runId: string,
  budget: RunBudget,
): Promise<BudgetCheck> {
  const within = await checkWithChildren(ctx, services, runId, budget, 'preflight');
  if (!within.ok) {
    await ctx.run('budget-preflight', async () => {
      await markRunBlocked(services.store, runId, 'limit', 'run blocked: ' + within.reason);
    });
  }
  return within;
}
