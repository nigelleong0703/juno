/**
 * Configured completion checks (PH10): the seam the run gate calls before it may report work done.
 *
 * The checks come from the user's configuration (never from the model), they run in the agent's bound
 * sandbox, and each one is executed at most once through the fence in ./check-runner.ts. This module
 * owns the deadline and the aggregation; a caller without a run cancellation gets a bounded one so
 * the checks can never hold the run open.
 */
import type { TodoCheck } from '@agent-desktop/public-contracts';
import { CANCELLED, type RunCancellation } from './cancel.js';
import { CHECK_TIMEOUT_MS, runCheck } from './check-runner.js';
import type { RunBudget } from './run-budget.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';

export { CHECK_TIMEOUT_MS } from './check-runner.js';

/**
 * A cancellation bounded to the check deadline, used when the caller has no run cancellation. It keeps
 * the fence's stop checks meaningful and makes the deadline a real stop rather than only a signal.
 */
export function boundedCheckCancellation(runSignal?: AbortSignal): RunCancellation {
  const signal = AbortSignal.any([
    AbortSignal.timeout(CHECK_TIMEOUT_MS),
    ...(runSignal === undefined ? [] : [runSignal]),
  ]);
  return {
    signal,
    state: { cancelled: false },
    peek: async () => signal.aborted,
    race: async (start) => (signal.aborted ? CANCELLED : start()),
    abort: () => undefined,
  };
}

export interface CheckOutcome {
  todoId: string;
  checkId: string;
  passed: boolean;
  summary: string;
}

export interface VerificationResult {
  passed: boolean;
  outcomes: CheckOutcome[];
  /** One actionable line naming each failing task, its check and why it failed. */
  note: string;
  /** True when the run budget (not a check result) stopped verification: no further effects may run. */
  budgetSpent: boolean;
}

/**
 * Run every configured check for the tasks marked done, each through its own fenced top-level steps
 * so a replay reuses what was observed instead of re-running a command.
 */
export async function runTodoChecks(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  groups: Array<{ todoId: string; checks: TodoCheck[] }>,
  key: string,
  cancellation?: RunCancellation,
  budget?: RunBudget,
): Promise<VerificationResult> {
  const stop = cancellation ?? boundedCheckCancellation();
  const outcomes: CheckOutcome[] = [];
  let ordinal = 0;
  for (const group of groups) {
    for (const check of group.checks) {
      ordinal += 1;
      const outcome = await runCheck(ctx, services, input, runId, check, key, ordinal, stop, budget);
      if (outcome.spent === true) return { passed: false, outcomes, note: 'run budget spent during verification: ' + outcome.summary, budgetSpent: true };
      outcomes.push({ todoId: group.todoId, checkId: check.id, passed: outcome.passed, summary: outcome.summary });
    }
  }
  const failed = outcomes.filter((entry) => !entry.passed);
  if (failed.length === 0) return { passed: true, outcomes, note: 'configured completion checks passed', budgetSpent: false };
  const note = failed
    .map((entry) => 'task ' + entry.todoId + ' check ' + entry.checkId + ': ' + entry.summary)
    .join('; ');
  return { passed: false, outcomes, note, budgetSpent: false };
}
