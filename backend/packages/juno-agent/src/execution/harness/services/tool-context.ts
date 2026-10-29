import type { ToolContext } from '../../../contracts/index.js';
import type { RunInput, RunServices } from './run-types.js';

/**
 * Tool-facing context shared by tool execution and first-model tool disclosure.
 * `step` stays a passthrough so no nested durable effect is created inside a tool effect.
 * The brain auxiliary hooks travel through so a preparer can request a native-only
 * System One decision without new ports; the harness passes `brain.systemOne` as agreed.
 */
export function buildToolContext(
  services: RunServices,
  input: RunInput,
  runId: string,
  wake: RunInput['wakeEvents'][number],
  signal: AbortSignal,
  stepId: string,
): ToolContext {
  return {
    ownerId: wake.ownerId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    runId,
    stepId,
    store: services.store,
    blobs: services.blobs,
    enqueuer: services.enqueuer,
    wake,
    step: <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    signal,
    ...(input.supportsImages === undefined ? {} : { supportsImages: input.supportsImages }),
    ...(input.toolSearch === undefined ? {} : { toolSearch: input.toolSearch }),
    ...(input.toolScope === undefined ? {} : { toolScope: input.toolScope }),
    ...(services.brain.quickText === undefined ? {} : { quickText: services.brain.quickText.bind(services.brain) }),
    ...(services.brain.systemOne === undefined ? {} : { systemOne: services.brain.systemOne }),
  };
}
