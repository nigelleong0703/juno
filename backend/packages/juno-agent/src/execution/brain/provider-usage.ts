/**
 * Honest mapping of measured provider usage onto the harness turn (PH11, LOOP-COST1).
 *
 * pi-ai initializes `usage` to all zeros and only replaces it when the wire actually reports usage, so
 * an all-zero object is ambiguous: it cannot be proven to be a real zero. A counter above zero is
 * treated as reported; an absent or all-zero usage is unmeasured, and then cost and cache are unknown
 * too. `costUsd` stays numeric for legacy consumers, but 0 with `costKnown:false` means unknown, never
 * free. Explicit free pricing (all-zero rates present) is known free; missing pricing (undefined rates)
 * stays unknown even though the wire cost is zero. Kept apart from the provider so each file stays small.
 *
 * Boundary rule: every counter must be a finite nonnegative safe integer and the cost total a finite
 * nonnegative number. Any malformed counter poisons the whole sample (nothing measured, nothing
 * charged, nothing claimed known); a malformed cost total keeps valid counters measured but the cost
 * unknown. Free-vs-unknown is decided only after valid measurements.
 */
import type { AssistantTurn } from '../../contracts/index.js';
import type { ModelCost, Usage } from '@earendil-works/pi-ai';

function unmeasured(): AssistantTurn['usage'] {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costKnown: false, measured: false };
}

/** Token counters must be exact safe integers; wire garbage is never measured. */
function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A USD total is valid when finite and nonnegative; fractional cents are real. */
function validCostTotal(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function toAssistantUsage(usage: Usage | undefined, rates: ModelCost | undefined): AssistantTurn['usage'] {
  if (usage === undefined) return unmeasured();
  const input = usage.input;
  const output = usage.output;
  const cacheRead = usage.cacheRead;
  const cacheWrite = usage.cacheWrite;
  if (!validCounter(input) || !validCounter(output) || !validCounter(cacheRead) || !validCounter(cacheWrite)) {
    return unmeasured();
  }
  const measured = input + output + cacheRead + cacheWrite > 0;
  const reported = usage.cost?.total;
  const costKnown = measured && rates !== undefined && validCostTotal(reported);
  return {
    inputTokens: measured ? input : 0,
    outputTokens: measured ? output : 0,
    cacheReadTokens: measured ? cacheRead : 0,
    cacheWriteTokens: measured ? cacheWrite : 0,
    costUsd: costKnown && reported !== undefined ? reported : 0,
    costKnown,
    measured,
  };
}
