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
): Promise<BrainContext> {
  let context = previousContext;
  if (stepIndex > 0) {
    context = await guardModelSelection(() => ctx.run(`context:${stepIndex}`, async () => journaled(services, await services.brain.buildContext({
      agentId: input.agentId, conversationId: input.conversationId, sessionKey: input.sessionKey,
      wake: input.wakeEvents, previousContext: context, noteKey: `ctxN:${runId}:${stepIndex}`, toolNames: tools.map((tool) => tool.name),
    }))));
  }
  if (services.brain.shouldCompact(context)) {
    const before = context;
    context = await guardModelSelection(() => ctx.run(`compact:${stepIndex}`, () => compactAndRefresh(services, input, before, tools, `ctxN:${runId}:${stepIndex}:compact`)));
    const compactWithin = await chargeCompactionStep({ ctx, services, runId, budget, key: 'compact:' + String(stepIndex), context });
    if (!compactWithin.ok) throw BUDGET_EXHAUSTED;
  }
  return context;
}
