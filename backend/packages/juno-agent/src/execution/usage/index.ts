// PH11 usage and budget accounting. Pure and journal-friendly: every observation is keyed so a
// durable replay of the same model/tool action cannot double count, cost stays explicitly unknown
// when no real price was reported (a legacy 0 is never "free"), and active time excludes waiting.

export interface BudgetLimits {
  steps?: number;
  tokens?: number;
  activeSeconds?: number;
  costUsd?: number;
  /** What to do when a counter is unknown: block truthfully (default) or enforce only the known lower bound. */
  onUnknown?: 'block' | 'ignore';
}

export interface UsageTotals {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  activeMs: number;
}

export interface UsageSample {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** True only when a real price was reported; absent or false means the cost is unknown. */
  costKnown?: boolean;
  /**
   * False when the provider reported no usage at all. Accompanying non-zero counters are an
   * honest partial lower bound: they are still added to the totals while the unknown flag
   * records that the true spend may be higher. Never zero real observations to fake exactness.
   */
  measured?: boolean;

  /**
   * False when the accompanying active duration could not be measured (malformed clock
   * reading). Absent means measured. Unmeasurable time is never counted as free work: it
   * contributes nothing to the total while the unknown-active flag lets the frozen onUnknown
   * policy block truthfully.
   */
  activeKnown?: boolean;
}

export interface UsageState {
  readonly limits: BudgetLimits;
  readonly totals: UsageTotals;
  /** True once any observed action reported an unknown price. */
  readonly unknownCost: boolean;
  /** True once any observed action reported no token usage at all. */
  readonly unknownTokens: boolean;
  /** True once any charged duration could not be measured. Unmeasurable time is never free work. */
  readonly unknownActive: boolean;
  /** Observation keys already counted, so replay adds nothing. */
  readonly counted: ReadonlySet<string>;
}

export type BudgetCheck = { ok: true } | { ok: false; reason: string };

export function totalTokens(totals: UsageTotals): number {
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}

export function createUsageState(limits: BudgetLimits = {}): UsageState {
  // Clone and freeze: mutating the settings object later must not move a frozen run's budget.
  const frozen = Object.freeze({ ...limits });
  return {
    limits: frozen,
    totals: {
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      activeMs: 0,
    },
    unknownCost: false,
    unknownTokens: false,
    unknownActive: false,
    counted: new Set<string>(),
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Optional owner-global budget fields; a missing or malformed field is simply unenforced. */
export function parseBudgetLimits(settings: unknown): BudgetLimits {
  if (typeof settings !== 'object' || settings === null) return {};
  const usage: unknown = Reflect.get(settings, 'usage');
  if (typeof usage !== 'object' || usage === null) return {};
  const limits: BudgetLimits = {};
  const steps = readNumber(Reflect.get(usage, 'steps'));
  const tokens = readNumber(Reflect.get(usage, 'tokens'));
  const activeSeconds = readNumber(Reflect.get(usage, 'activeSeconds'));
  const costUsd = readNumber(Reflect.get(usage, 'costUsd'));
  if (steps !== undefined) limits.steps = steps;
  if (tokens !== undefined) limits.tokens = tokens;
  if (activeSeconds !== undefined) limits.activeSeconds = activeSeconds;
  if (costUsd !== undefined) limits.costUsd = costUsd;
  const onUnknown: unknown = Reflect.get(usage, 'onUnknown');
  // An explicit user cost/token budget blocks on unknown counters unless the user chose otherwise;
  // a static default cap only enforces the known lower bound so normal runs do not stall.
  if ((costUsd !== undefined || tokens !== undefined) && limits.onUnknown === undefined) limits.onUnknown = 'block';
  if (onUnknown === 'block' || onUnknown === 'ignore') limits.onUnknown = onUnknown;
  return limits;
}

/**
 * Saturating addition: totals must stay JSON-safe and finite, so an overflowing observation
 * saturates at MAX_SAFE_INTEGER and reports overflow instead of polluting persisted usage
 * with Infinity or silently rounded exactness.
 */
function saturate(total: number, amount: number): { value: number; overflow: boolean } {
  if (amount === 0) return { value: total, overflow: false };
  const sum = total + amount;
  if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) return { value: Number.MAX_SAFE_INTEGER, overflow: true };
  return { value: sum, overflow: false };
}

/** Count one model/tool action once per key; a replayed key is a no-op. */
export function observeUsage(state: UsageState, sample: UsageSample, key: string): UsageState {
  if (state.counted.has(key)) return state;
  const costKnown = sample.costKnown === true;
  const measured = sample.measured !== false;
  // Sanitize one observed counter. Token counters must be finite non-negative safe integers
  // (fractions and unsafe integers are malformed); money must be a finite non-negative number.
  // Absent is valid only where the claim allows it: required claims (measured input/output,
  // known cost) that are missing or null mark the dimension unknown instead of assuming free.
  const cleanTokens = (value: unknown, required: boolean): { amount: number; valid: boolean } => {
    if (value === undefined || value === null) return { amount: 0, valid: !required };
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? { amount: value, valid: true }
      : { amount: 0, valid: false };
  };
  const cleanCost = (value: unknown, required: boolean): { amount: number; valid: boolean } => {
    if (value === undefined || value === null) return { amount: 0, valid: !required };
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? { amount: value, valid: true }
      : { amount: 0, valid: false };
  };
  const input = cleanTokens(sample.inputTokens, measured);
  const output = cleanTokens(sample.outputTokens, measured);
  const cacheRead = cleanTokens(sample.cacheReadTokens, false);
  const cacheWrite = cleanTokens(sample.cacheWriteTokens, false);
  const cost = cleanCost(sample.costUsd, costKnown);
  const tokensClean = input.valid && output.valid && cacheRead.valid && cacheWrite.valid;
  const nextInput = saturate(state.totals.inputTokens, input.amount);
  const nextOutput = saturate(state.totals.outputTokens, output.amount);
  const nextCacheRead = saturate(state.totals.cacheReadTokens, cacheRead.amount);
  const nextCacheWrite = saturate(state.totals.cacheWriteTokens, cacheWrite.amount);
  const nextCost = saturate(state.totals.costUsd, cost.amount);
  const tokensOverflow = nextInput.overflow || nextOutput.overflow || nextCacheRead.overflow || nextCacheWrite.overflow;
  const counted = new Set(state.counted);
  counted.add(key);
  return {
    limits: state.limits,
    // Totals are honest lower bounds: sanitized observed amounts are always added, even when
    // the observation is partial (measured false) or unpriced (costKnown false). The flags record
    // incompleteness so ceilings enforce the lower bound and the frozen onUnknown policy can
    // block truthfully; malformed numbers never reduce the totals, they only mark unknown.
    unknownCost: state.unknownCost || !costKnown || !cost.valid || nextCost.overflow,
    unknownTokens: state.unknownTokens || !measured || !tokensClean || tokensOverflow,
    unknownActive: state.unknownActive || sample.activeKnown === false,
    counted,
    totals: {
      steps: state.totals.steps + 1,
      inputTokens: nextInput.value,
      outputTokens: nextOutput.value,
      cacheReadTokens: nextCacheRead.value,
      cacheWriteTokens: nextCacheWrite.value,
      costUsd: nextCost.value,
      activeMs: state.totals.activeMs,
    },
  };
}

/**
 * Add measured active time. With a key the addition is replay-safe, so a replayed execution span is
 * never counted twice; without a key the caller is responsible for not re-adding. Non-finite or
 * negative durations are malformed and contribute nothing, so NaN can never poison the total
 * and bypass the active-time ceiling.
 */
export function addActiveMs(state: UsageState, activeMs: number, key?: string): UsageState {
  const delta = typeof activeMs === 'number' && Number.isFinite(activeMs) && activeMs > 0 ? activeMs : 0;
  const valid = typeof activeMs === 'number' && Number.isFinite(activeMs) && activeMs >= 0;
  const next = saturate(state.totals.activeMs, delta);
  const withTime = { ...state, unknownActive: state.unknownActive || !valid, totals: { ...state.totals, activeMs: next.value } };
  if (key === undefined) return withTime;
  const marker = 'active:' + key;
  if (state.counted.has(marker)) return state;
  const counted = new Set(state.counted);
  counted.add(marker);
  return { ...withTime, counted };
}

/** Compare observed spend against the frozen limits; never predicts a future exact total. */
export function checkBudget(state: UsageState): BudgetCheck {
  const { limits, totals } = state;
  // Default is to enforce only the known lower bound; blocking on unknown is opt-in.
  const blockUnknown = limits.onUnknown === 'block';
  if (limits.steps !== undefined && totals.steps >= limits.steps) {
    return { ok: false, reason: 'step budget reached (' + String(totals.steps) + '/' + String(limits.steps) + ')' };
  }
  const tokens = totalTokens(totals);
  if (limits.tokens !== undefined) {
    if (tokens >= limits.tokens) {
      return { ok: false, reason: 'token budget reached (' + String(tokens) + '/' + String(limits.tokens) + ')' };
    }
    if (state.unknownTokens && blockUnknown) {
      return { ok: false, reason: 'token budget cannot be enforced: some actions reported no usage (known ' + String(tokens) + '/' + String(limits.tokens) + ')' };
    }
  }
  if (limits.activeSeconds !== undefined && totals.activeMs >= limits.activeSeconds * 1000) {
    return { ok: false, reason: 'active time budget reached (' + String(Math.round(totals.activeMs / 1000)) + '/' + String(limits.activeSeconds) + 's)' };
  }
  if (limits.activeSeconds !== undefined && state.unknownActive && blockUnknown) {
    return { ok: false, reason: 'active time budget cannot be enforced: some actions reported no measurable duration (known ' + String(Math.round(totals.activeMs / 1000)) + '/' + String(limits.activeSeconds) + 's)' };
  }
  if (limits.costUsd !== undefined) {
    // The known lower bound always enforces, even when part of the spend is unknown.
    if (totals.costUsd >= limits.costUsd) {
      return { ok: false, reason: 'cost budget reached (' + totals.costUsd.toFixed(4) + '/' + String(limits.costUsd) + ')' };
    }
    if (state.unknownCost && blockUnknown) {
      return { ok: false, reason: 'cost budget cannot be enforced: some actions reported no price (known ' + totals.costUsd.toFixed(4) + '/' + String(limits.costUsd) + ')' };
    }
  }
  return { ok: true };
}
