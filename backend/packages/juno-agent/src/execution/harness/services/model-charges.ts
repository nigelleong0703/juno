/** Pure per-action budget charges (PH11): measured spend accumulates, unknowns never invent it. */
import type { RunBudget } from './run-budget.js';

/** Charge measured active time only: a tool effect, or a failed request that reported no usage. */
export function chargeActive(budget: RunBudget, key: string, activeMs: number): void {
  // No tokens and no price are invented, and neither unknown flag is poisoned by them. An
  // unmeasurable duration still marks unknown-active so an explicit ceiling cannot be bypassed.
  const valid = typeof activeMs === 'number' && Number.isFinite(activeMs) && activeMs >= 0;
  budget.charge(key, { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true, measured: true, activeKnown: valid }, valid ? activeMs : 0);
}

/** Charge a failed provider attempt: neither its tokens nor its price are reported as measured. */
export function chargeFailedAttempt(budget: RunBudget, key: string, activeMs: number): void {
  const valid = typeof activeMs === 'number' && Number.isFinite(activeMs) && activeMs >= 0;
  budget.charge(key, { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: false, measured: false, activeKnown: valid }, valid ? activeMs : 0);
}

/** Charge the compaction's observed usage (private metrics on the returned context) and duration. */
export function chargeCompaction(budget: RunBudget, key: string, context: { [key: string]: unknown }): void {
  const metrics: unknown = context['compactionMetrics'];
  if (typeof metrics !== 'object' || metrics === null) return;
  const durationMs = Reflect.get(metrics, 'durationMs');
  const usage: unknown = Reflect.get(metrics, 'usage');
  if (typeof usage !== 'object' || usage === null) {
    chargeActive(budget, key, typeof durationMs === 'number' ? durationMs : NaN);
    return;
  }
  budget.charge(
    key,
    {
      inputTokens: Number(Reflect.get(usage, 'inputTokens')) || 0,
      outputTokens: Number(Reflect.get(usage, 'outputTokens')) || 0,
      cacheReadTokens: Number(Reflect.get(usage, 'cacheReadTokens')) || 0,
      cacheWriteTokens: Number(Reflect.get(usage, 'cacheWriteTokens')) || 0,
      costUsd: Number(Reflect.get(usage, 'costUsd')) || 0,
      costKnown: Reflect.get(usage, 'costKnown') === true,
      measured: Reflect.get(usage, 'measured') !== false,
      activeKnown: typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0,
    },
    typeof durationMs === 'number' ? durationMs : NaN,
  );
}
