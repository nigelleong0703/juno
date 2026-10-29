/**
 * Routine completion reporting: derive the routine link from the run's wakes, count its visible
 * outputs inside the same journaled step, and forward one completion to its timer. Runs that
 * no routine started report nothing; stopped/blocked runs record no completion either.
 */
import type { RestatePromise } from '@agent-desktop/durable';
import { collectRoutineOutputs } from '../../../modules/tasks/routines/results.js';
import type { CompletionParams } from './routineTimer.js';
import type { RunInput, RunServices } from './run-types.js';

export type ReportParams = CompletionParams;

export interface ReportContext {
  run<T>(name: string, action: () => Promise<T>): RestatePromise<T>;
  completeRoutine?(params: ReportParams): Promise<void>;
}

/** The routine wake that started this run, if any: id plus occurrence for the run record. */
function routineLink(input: RunInput): { routineId: string; occurrenceAt: string } | undefined {
  const wake = input.wakeEvents.find((event) => event.kind === 'routine' || event.kind === 'monitor');
  if (wake === undefined) return undefined;
  const routineId = wake.payload.routineId;
  if (typeof routineId !== 'string' || routineId.length === 0) return undefined;
  const occurrenceAt = wake.payload.occurrenceAt;
  return { routineId, occurrenceAt: typeof occurrenceAt === 'string' ? occurrenceAt : wake.at };
}

/** Count and forward one finished routine run; a non-routine run is a silent no-op. */
export async function reportRoutineCompletion(
  ctx: ReportContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  result: { succeeded: boolean; summary?: string },
): Promise<void> {
  const link = routineLink(input);
  if (link === undefined) return;
  const collected = await ctx.run('count-outputs', () => collectRoutineOutputs(services.store, input.conversationId, runId));
  await ctx.completeRoutine?.({
    routineId: link.routineId,
    runId,
    occurrenceAt: link.occurrenceAt,
    succeeded: result.succeeded,
    itemsGenerated: collected.count,
    outputIds: collected.ids,
    ...(result.summary === undefined ? {} : { summary: result.summary }),
  });
}
