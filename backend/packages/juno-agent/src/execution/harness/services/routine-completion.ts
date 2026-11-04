/**
 * Routine completion reporting: derive the routine link from the run's wakes, count its visible
 * outputs inside the same journaled step, and forward one completion to its timer. Runs that
 * no routine started report nothing; stopped/blocked runs record no completion either.
 */
import type { DurablePromise } from '@agent-desktop/durable';
import { collectRoutineOutputs } from '../../../modules/tasks/routines/results.js';
import { finishTrialRun } from '../../../modules/tasks/routines/preview.js';
import type { CompletionParams } from './routineTimer.js';
import { speaksOnlyBySend } from '../logic/run-origin.js';
import { planRefire, refireStateOf, refireWake } from '../logic/routine-refire.js';
import type { RunInput, RunServices } from './run-types.js';

export type ReportParams = CompletionParams;

export interface ReportContext {
  run<T>(name: string, action: () => Promise<T>): DurablePromise<T>;
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

/**
 * The next attempt of this occurrence when its run failed because the model provider was unavailable and nobody waits on the run (planRefire
 * limits: three re-fires, the longer of the announced wait and five minutes, never later than two hours after the first attempt). Decided in one
 * journaled step, so a replay plans the same.
 */
async function refireOf(ctx: ReportContext, services: RunServices, input: RunInput, runId: string, outage: { retryAfterMs?: number }): Promise<ReportParams['refire']> {
  return ctx.run('refire-plan', async () => {
    const wake = input.wakeEvents.find((event) => event.kind === 'routine' || event.kind === 'monitor');
    const run = await services.store.get('runs', runId);
    if (wake === undefined || run === null || !speaksOnlyBySend(run)) return undefined;
    const plan = planRefire({ previous: refireStateOf(wake), startedAt: run.startedAt, now: Date.now(), retryAfterMs: outage.retryAfterMs });
    return plan === undefined ? undefined : { wake: refireWake(wake, plan.next), delayMs: plan.delayMs };
  });
}

/** Count and forward one finished routine run; a non-routine run is a silent no-op. */
export async function reportRoutineCompletion(
  ctx: ReportContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  result: { succeeded: boolean; summary?: string; providerOutage?: { retryAfterMs?: number } },
): Promise<void> {
  const link = routineLink(input);
  if (link === undefined) return;
  // One journaled step: the outputs, and for a run on trial (preview.ts) the one card asking whether to turn the routine on.
  const collected = await ctx.run('count-outputs', async () => {
    const outputs = await collectRoutineOutputs(services.store, input.conversationId, runId);
    const trial = result.succeeded ? await finishTrialRun(services.store, input.wakeEvents[0]?.ownerId ?? '', link.routineId, runId) : undefined;
    return { ...outputs, ...(trial === undefined ? {} : { trial }) };
  });
  const refire = !result.succeeded && result.providerOutage !== undefined ? await refireOf(ctx, services, input, runId, result.providerOutage) : undefined;
  await ctx.completeRoutine?.({
    routineId: link.routineId,
    runId,
    occurrenceAt: link.occurrenceAt,
    succeeded: result.succeeded,
    itemsGenerated: collected.count,
    outputIds: collected.ids,
    ...(result.summary !== undefined ? { summary: result.summary } : collected.trial === undefined ? {} : { summary: collected.trial }),
    ...(refire === undefined ? {} : { refire }),
  });
}
