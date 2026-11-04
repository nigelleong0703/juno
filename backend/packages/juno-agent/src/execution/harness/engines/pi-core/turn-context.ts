/** Durable turn-context preparation: rebuild the model context and compact it when asked. */
import { toTerminalModelError } from '../../../brain/model-selection.js';
import type { BrainContext, Tool } from '../../../../contracts/index.js';
import type { RunBudget } from '../../services/run-budget.js';
import { chargeCompactionStep } from '../../services/model-budget.js';
import type { RunContext, RunInput, RunServices } from '../../services/run-types.js';

/** Observed spend exhausted the frozen budget: the run blocks truthfully instead of retrying. */
export const BUDGET_EXHAUSTED = new Error('pi-core: budget exhausted');

/** Convert a permanent account-model failure to terminal; pass everything else through. */
export async function guardModelSelection<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const terminal = toTerminalModelError(error);
    if (terminal) throw terminal;
    throw error;
  }
}

/**
 * The steps of this run at which a compaction was committed. Built only from journaled results (a compaction that changed the epoch), so a replay
 * rebuilds the same list.
 */
export interface CompactionLog {
  steps: number[];
}

/** Two compactions this close together mean compacting does not help: the history is still too big right after it. */
export const THRASH_WINDOW_STEPS = 5;

/** Thrown instead of compacting a second time within the window; the turn ends the run `blocked` (turn.ts). */
export const COMPACTION_THRASH = new Error('pi-core: compaction does not help');

/** Whether a compaction at `stepIndex` would be the second one within the window. */
export const recentlyCompacted = (log: CompactionLog, stepIndex: number): boolean => log.steps.some((step) => stepIndex - step < THRASH_WINDOW_STEPS);

/** A journaled context is the slim reference (no message list); test brains without `slim` journal as is. */
export function journaled(services: RunServices, context: BrainContext): BrainContext {
  return services.brain.slim?.(context) ?? context;
}

/**
 * Compact a context and re-deliver the context sections afterwards. The compaction drops the notes
 * it summarized, so the rebuild (same journaled step) appends a fresh note carrying every section the
 * projection can no longer see; the measured compaction cost rides on the result for the budget charge.
 */
export async function compactAndRefresh(
  services: RunServices,
  input: RunInput,
  context: BrainContext,
  tools: Tool[],
  noteKey: string,
): Promise<BrainContext> {
  const compacted = await services.brain.compact(context, tools);
  // Nothing was committed (no-op, failed or lost the race): the context is unchanged, only the measurement rides along.
  if (compacted.compactionEpoch === context.compactionEpoch) return journaled(services, compacted);
  const refreshed = await services.brain.buildContext({
    agentId: input.agentId, conversationId: input.conversationId, sessionKey: input.sessionKey,
    wake: input.wakeEvents, previousContext: compacted, noteKey, toolNames: tools.map((tool) => tool.name),
  });
  return journaled(services, compacted.compactionMetrics === undefined ? refreshed : { ...refreshed, compactionMetrics: compacted.compactionMetrics });
}

/** Rebuild the model context for a step, and compact it when the brain asks; both are durable steps. */
export async function prepareTurnContext(
  ctx: RunContext,
  services: RunServices,
  input: RunInput,
  stepIndex: number,
  previousContext: BrainContext,
  budget: RunBudget,
  runId: string,
  tools: Tool[],
  compactions: CompactionLog,
): Promise<BrainContext> {
  let context = previousContext;
  if (stepIndex > 0) {
    context = await guardModelSelection(() => ctx.run(`context:${stepIndex}`, async () => journaled(services, await services.brain.buildContext({
      agentId: input.agentId, conversationId: input.conversationId, sessionKey: input.sessionKey,
      wake: input.wakeEvents, previousContext: context, noteKey: `ctxN:${runId}:${stepIndex}`, toolNames: tools.map((tool) => tool.name),
    }))));
  }
  if (services.brain.shouldCompact(context)) {
    // The second compaction within a few steps would only repeat the first: the run ends blocked instead of looping on summaries.
    if (recentlyCompacted(compactions, stepIndex)) throw COMPACTION_THRASH;
    const before = context;
    context = await guardModelSelection(() => ctx.run(`compact:${stepIndex}`, () => compactAndRefresh(services, input, before, tools, `ctxN:${runId}:${stepIndex}:compact`)));
    if (context.compactionEpoch !== before.compactionEpoch) compactions.steps.push(stepIndex);
    const compactWithin = await chargeCompactionStep({ ctx, services, runId, budget, key: 'compact:' + String(stepIndex), context });
    if (!compactWithin.ok) throw BUDGET_EXHAUSTED;
  } else if (services.brain.shouldTrim?.(context) === true && services.brain.trimResults !== undefined) {
    // Below the compaction trigger but past the trim share: the old large tool results become stubs, once, as an epoch boundary (BACKEND §3.5.2b).
    const trim = services.brain.trimResults.bind(services.brain);
    const before = context;
    context = await guardModelSelection(() => ctx.run(`trim:${stepIndex}`, async () => journaled(services, await trim(before))));
  }
  return context;
}
