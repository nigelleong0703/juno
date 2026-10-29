/**
 * CT-boundary: the canonical child-scope role of one run and the turn-driver seams it silences.
 *
 * The stored parent link on the run row is the only authority for "this run is a child work
 * item"; it is written at reservation and never model-controlled. The read is a durable journal
 * step keyed by the outer step, so a replay derives the same role. A child run posts no streamed
 * bubbles — its result lands on the run row (childResult + run.updated) — while steps/run updates
 * and the internal transcript stay intact.
 */
import type { ToolResult } from '../../../contracts/index.js';
import { isChildRun } from '../../../modules/tasks/childDelivery.js';
import type { RunContext, RunServices } from './run-types.js';

/** Journal-read the run row by its real id and report whether it is a child run. */
export async function readChildChatRole(ctx: RunContext, services: RunServices, runId: string, stepIndex: number): Promise<boolean> {
  const row = await ctx.run('run-role:' + String(stepIndex), () => services.store.get('runs', runId));
  return isChildRun(row);
}

/** A child wait reported in details without a suspend: validate it before suspending. */
export function childSuspendFromDetails(details: ToolResult['details']): ToolResult['suspend'] {
  if (details === undefined || details['child'] !== true || !Array.isArray(details['waiting'])) return undefined;
  const ids = details['waiting'].filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length > 0 ? { reason: 'child' } : undefined;
}
