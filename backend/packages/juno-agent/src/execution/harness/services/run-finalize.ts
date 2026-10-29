/**
 * Run terminal finalization: persist one terminal outcome (failed/stopped/blocked/completed),
 * release descendants and pending requests, and report routine completions to their timer.
 * Pure orchestration over the journaled context; the loop in run.ts only decides the outcome.
 */
import { blockRunTasks } from './task-hooks.js';
import { cancelChildrenOfRun } from '../../../modules/tasks/childTools.js';
import { expirePendingRequests } from '../../child-run-input.js';
import { emitAgentStatus } from '../../agent-status.js';
import { closeRunTasks } from '../../../modules/tasks/agent-tasks.js';
import { reportRoutineCompletion, type ReportContext } from './routine-completion.js';
import { startStepSummaries } from './run-aux.js';
import { runTerminalEvent } from './agui-events.js';
import type { RunInput, RunServices } from './run-types.js';

export type TerminalOutcome =
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' }
  | { kind: 'blocked' }
  | { kind: 'completed' };

/** Finalize one terminal outcome; stopped and blocked record no routine completion. */
export async function finalizeTerminalRun(
  ctx: ReportContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  outcome: TerminalOutcome,
): Promise<void> {
  if (outcome.kind === 'failed') {
    await ctx.run('fail', async () => {
      await expirePendingRequests(services.store, runId);
      // CT-boundary: descendants are stopped for real; transient retries rethrow above, never here.
      await cancelChildrenOfRun(services.store, (childRunId) => services.enqueuer.stopRun(childRunId), runId);
      const failed = await services.store.patch('runs', runId, { status: 'failed', finishedAt: new Date().toISOString(), error: outcome.message });
      await services.store.emit(runTerminalEvent(failed));
      await closeRunTasks(services.store, failed);
      await emitAgentStatus(services.store, failed.agentId);
      startStepSummaries(services, runId);
    });
    await reportRoutineCompletion(ctx, services, input, runId, { succeeded: false, summary: outcome.message });
    return;
  }
  if (outcome.kind === 'stopped') {
    await ctx.run('stop', async () => {
      await expirePendingRequests(services.store, runId);
      // A real stop also stops this parent's children; the enqueuer call is a plain RPC.
      await cancelChildrenOfRun(services.store, (childRunId) => services.enqueuer.stopRun(childRunId), runId);
      const current = await services.store.get('runs', runId);
      if (current?.status !== 'stopped') {
        const stopped = await services.store.patch('runs', runId, {
          status: 'stopped',
          finishedAt: new Date().toISOString(),
        });
        await services.store.emit(runTerminalEvent(stopped));
        await closeRunTasks(services.store, stopped);
        await emitAgentStatus(services.store, stopped.agentId);
      startStepSummaries(services, runId);
      }
    });
    return;
  }
  if (outcome.kind === 'blocked') {
    // A blocked run records its reason on the outstanding todos and stops its descendants.
    await ctx.run('blocked', async () => {
      await expirePendingRequests(services.store, runId);
      // CT-boundary: a blocked parent stops the descendants it can no longer collect.
      await cancelChildrenOfRun(services.store, (childRunId) => services.enqueuer.stopRun(childRunId), runId);
      const current = await services.store.get('runs', runId);
      const reason = current?.error ?? 'run blocked: outstanding tasks need input';
      await blockRunTasks(services.store, input.agentId, input.conversationId, reason, runId);
      const blocked = await services.store.patch('runs', runId, {
        status: 'blocked',
        finishedAt: new Date().toISOString(),
        error: reason,
        // The reason text above is the default only when no gate wrote a cause: outstanding tasks need input.
        blockCause: current?.blockCause ?? 'needs_input',
      });
      await services.store.emit(runTerminalEvent(blocked));
      await closeRunTasks(services.store, blocked);
      await emitAgentStatus(services.store, blocked.agentId);
      startStepSummaries(services, runId);
    });
    return;
  }
  await ctx.run('finish', async () => {
    await expirePendingRequests(services.store, runId, { keepInterrupted: true });
    const finished = await services.store.patch('runs', runId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
    });
    await services.store.emit(runTerminalEvent(finished));
    await closeRunTasks(services.store, finished);
    await emitAgentStatus(services.store, finished.agentId);
    startStepSummaries(services, runId);
  });
  await reportRoutineCompletion(ctx, services, input, runId, { succeeded: true });
}
