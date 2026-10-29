import { runLoop } from '../services/run-loop.js';
import type { EngineAdapter, EngineOutcome, EngineTurnContext } from './registry.js';

/**
 * The current pi-ai durable loop as a full-turn adapter. It delegates to the
 * existing runLoop exactly once per turn — the adapter never wraps a single
 * Brain.step and the loop keeps owning tool execution, cancellation and replay.
 */
export const PI_ENGINE_VERSION = '1';

export function createPiAdapter(): EngineAdapter {
  const executeTurn = async (context: EngineTurnContext): Promise<EngineOutcome> =>
    runLoop(context.ctx, context.services, context.input, context.runId, context.brainCtx, context.cancellation);
  return {
    id: 'pi',
    name: 'Current engine',
    version: PI_ENGINE_VERSION,
    available: true,
    capabilities: { tools: true, approvals: true, steering: true, deltas: true },
    executeTurn,
  };
}
