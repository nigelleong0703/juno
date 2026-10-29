/**
 * The Restate outer run driver.
 *
 * Restate stays the only durable execution owner: this loop owns the run's step budget,
 * the cancellation checks between steps and the terminal decision, while pi-agent-core
 * owns the inner turn (provider request, tool batch, turn finalization) through the
 * qualified driver in `../engines/pi-core/turn.js`. One outer step is exactly one core
 * turn, so the model/tool/steering/todo boundaries stay individually journaled and the
 * old hand-rolled self-loop is retired.
 */
import { LIMITS, type Brain } from '../../../contracts/index.js';
import { chatTakesReactions } from '../../brain/index.js';
import { offersQuietExit } from '../logic/run-origin.js';
import { runCoreTurn } from '../engines/pi-core/turn.js';
import type { LengthBudget } from '../engines/pi-core/types.js';
import type { EngineOutcome } from '../engines/registry.js';
import type { RunCancellation } from './cancel.js';
import { createStepTimer } from './step-timer.js';
import { recordRunHop } from './chain-cost.js';
import { withBrowserCompletionGate } from './browser-completion.js';
import { createTodoGate } from './todo-gate.js';
import { markRunBlocked } from './run-block.js';
import { loadRunBudget, persistBudgetSnapshot, preflightBudget } from './run-budget.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';
import type { CardRetryBudget, ReplyCitation } from './final-reply.js';

/** A run that spent its step budget never produced a settled final, so it is blocked, not complete. */
const STEP_LIMIT_REASON = 'run blocked: the step limit was reached before the run produced a final answer';

export async function runLoop(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  brainCtx: Awaited<ReturnType<Brain['buildContext']>>,
  cancellation: RunCancellation,
): Promise<EngineOutcome> {
  // Freeze the budget once before any model call; a child inherits its stored snapshot, and the
  // frozen snapshot is persisted for its own children.
  const stored = await ctx.run('load-run-link', () => services.store.get('runs', runId));
  const parentRunId = stored?.parentRunId;
  await ctx.run('run-hop', () => recordRunHop(services.store, input, runId));
  const budget = await loadRunBudget(ctx, services, input.wakeEvents[0]?.ownerId ?? '', parentRunId === undefined ? { runId } : { runId, parentRunId });
  await persistBudgetSnapshot(ctx, services, runId, budget);
  // An already-exhausted budget must not start a model call at all.
  if (!(await preflightBudget(ctx, services, runId, budget)).ok) return 'blocked';
  // The gate reads and blocks the authoritative plan and charges configured completion checks
  // against the SAME frozen budget, so it is created after the freeze and receives it.
  let gate = createTodoGate(ctx, services, input, runId, cancellation, budget);
  const deliveredTexts: string[] = [];
  const citations: ReplyCitation[] = [];
  // Derived only from journaled model turns, so a replay sets it at the same step.
  const progress = { working: false };
  const lengthBudget: LengthBudget = { count: 0 };
  const cardRetry: CardRetryBudget = { used: false };
  let context = brainCtx;
  await gate.announceBlocked('start');
  const goalBrowserMode = await ctx.run('browser-interface', async () => await services.toolRegistry.nativeBrowserAvailable?.(input.agentId) === true);
  if (goalBrowserMode) gate = withBrowserCompletionGate(gate, ctx, services, input, runId);
  // Read once and journaled, like the browser interface: the core tool list must not change within a run.
  const reactions = await ctx.run('chat-reactions', () => chatTakesReactions(services.store, input.conversationId));
  // The quiet exit exists only in a run nobody is waiting on; the tool list, like the reactions, does not change within a run.
  const quietExit = await ctx.run('quiet-exit', async () => offersQuietExit(await services.store.get('runs', runId)));
  let stepIndex = 0;

  while (stepIndex < LIMITS.run.maxSteps) {
    const timer = createStepTimer(ctx);
    if (await cancellation.peek() === true) return 'stopped';
    const turn = await runCoreTurn({
      ctx: timer.ctx, services, input, runId, stepIndex, brainCtx: context, cancellation, deliveredTexts, citations, progress, gate, lengthBudget, cardRetry,
      budget, goalBrowserMode, reactions, quietExit,
    });
    timer.report(services.log, { runId, step: stepIndex, outcome: turn.outcome });
    context = turn.brainCtx;
    if (turn.outcome === 'continued') {
      stepIndex += 1;
      continue;
    }
    // A real user stop wins over a terminal the turn reached concurrently.
    if (await cancellation.peek() === true) return 'stopped';
    return turn.outcome;
  }
  // The step limit is a budget, never a completion. The gate records the outstanding-task reason
  // when a plan exists; without one, the budget itself is still a blocked terminal, never a
  // completion (the model may simply have kept proposing tools).
  if (await cancellation.peek() === true) return 'stopped';
  if (await gate.afterStepLimit() === 'blocked') return 'blocked';
  await ctx.run('limit-block', async () => {
    await markRunBlocked(services.store, runId, 'limit', STEP_LIMIT_REASON);
  });
  return 'blocked';
}
