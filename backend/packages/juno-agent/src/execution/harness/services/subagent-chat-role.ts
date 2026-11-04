/**
 * CT-boundary: the canonical child-scope role of one run and the turn-driver seams it silences.
 *
 * The stored parent link on the run row is the only authority for "this run is a child work
 * item"; it is written at reservation and never model-controlled. The read is a durable journal
 * step keyed by the outer step, so a replay derives the same role. A child run posts no streamed
 * bubbles — its result lands on the run row (childResult + run.updated) — while steps/run updates
 * and the internal transcript stay intact.
 */
import { hasSubagentParent } from '../../../modules/tasks/subagentDelivery.js';
import type { RunContext, RunServices } from './run-types.js';

/** Journal-read the run row by its real id and report whether it is a child run. */
export async function readSubagentChatRole(ctx: RunContext, services: RunServices, runId: string, stepIndex: number): Promise<boolean> {
  const row = await ctx.run('run-role:' + String(stepIndex), () => services.store.get('runs', runId));
  return hasSubagentParent(row);
}
