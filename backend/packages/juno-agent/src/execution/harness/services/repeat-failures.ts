/**
 * The same call failing again and again (BACKEND §3.3 "repeated failing calls"). A run counts, per call (tool name + canonical arguments),
 * how many times in a row it was attempted and ended in an error. The third attempt is not executed: the model gets a tool error that
 * names the last error and asks it to change the arguments or the approach. The fifth attempt ends the run blocked (`no_progress`).
 *
 * The counts live on the run row (`StoredRun.callFailures`) and are only written inside the journaled step-update action of a call and
 * only read inside the journaled step-links action, so a replay sees the same numbers as the original execution. A call that succeeds
 * clears its own count: a flaky read that works again is not a loop.
 */
import { createHash } from 'node:crypto';
import type { Store, StoredRun, ToolResult } from '../../../contracts/index.js';
import { canonicalJson } from './recovery-ledger.js';
import { redactText, resultText } from './tool-projection.js';

/** Attempts that went wrong before this call: from the second on, the call is refused; from the fourth on, the run stops. */
export const REFUSE_AFTER_FAILURES = 2;
export const BLOCK_AFTER_FAILURES = 4;

/** The run row's record: per call, the attempts in a row that ended in an error and the last error. */
export type CallFailures = NonNullable<StoredRun['callFailures']>;

/** What the harness does with an attempt, given the failures already recorded for the same call. */
export type RepeatVerdict = { kind: 'run' } | { kind: 'refuse'; text: string } | { kind: 'block'; text: string; reason: string };

/** The identity of a call: its tool and its canonical arguments, hashed. */
export function callKey(name: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(name + '\n' + canonicalJson(args)).digest('hex').slice(0, 32);
}

const oneLine = (text: string): string => redactText(text.replace(/\s+/g, ' ').trim()).slice(0, 200);

export function repeatVerdict(failures: CallFailures | undefined, key: string): RepeatVerdict {
  const seen = failures?.[key];
  if (seen === undefined || seen.n < REFUSE_AFTER_FAILURES) return { kind: 'run' };
  const text = `This exact call already failed twice with: ${seen.error}. Change the arguments or approach, or stop and say what is blocking.`;
  if (seen.n < BLOCK_AFTER_FAILURES) return { kind: 'refuse', text };
  return { kind: 'block', text, reason: `The same step failed ${String(seen.n)} times in a row, so the run stopped. The last error: ${seen.error}` };
}

/** The failures after one more attempt ended: its error counted, or its success clearing the count. */
export function afterAttempt(failures: CallFailures | undefined, key: string, result: ToolResult | undefined): CallFailures | undefined {
  // An action nobody can tell the outcome of (or an identical call held back for it) is not a failing call: the agent is meant to check and may then repeat it.
  if (result?.details?.['uncertainOutcome'] === true) return failures;
  if (result?.isError !== true) {
    if (failures?.[key] === undefined) return failures;
    return Object.fromEntries(Object.entries(failures).filter(([other]) => other !== key));
  }
  // The error the model last saw, except that a refusal by this guard keeps the error that caused it.
  const error = result.details?.['repeatRefused'] === true ? failures?.[key]?.error ?? oneLine(resultText(result)) : oneLine(resultText(result));
  return { ...failures, [key]: { n: (failures?.[key]?.n ?? 0) + 1, error } };
}

/** The tool error the model reads when the guard refuses a call. */
export function refusedByGuard(text: string): ToolResult {
  return { content: [{ type: 'text', text: 'Error: ' + text }], isError: true, details: { errorKind: 'validation', repeatRefused: true } };
}

/** Write one attempt's outcome onto the run row (call inside the journaled step-update action). */
export async function recordAttempt(store: Store, runId: string, key: string, result: ToolResult | undefined): Promise<void> {
  const run = await store.get('runs', runId);
  if (run === null) return;
  const next = afterAttempt(run.callFailures, key, result);
  if (next !== run.callFailures) await store.patch('runs', runId, { callFailures: next ?? {} });
}

/** The recorded failures of a run, for the verdict (call inside the journaled step-links action). */
export async function repeatVerdictFor(store: Store, runId: string, key: string): Promise<RepeatVerdict> {
  return repeatVerdict((await store.get('runs', runId))?.callFailures, key);
}
