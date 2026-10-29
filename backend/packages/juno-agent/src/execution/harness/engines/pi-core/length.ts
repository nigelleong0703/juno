/**
 * Token-limit continuation for the pi-agent-core inner turn: a truncated turn is never a completion.
 */
import { appendToTranscript } from '../../../brain/index.js';
import { markRunBlocked } from '../../services/run-block.js';
import { taskHintMessage } from '../../services/task-hooks.js';
import type { SettleDecision } from '../../services/todo-gate.js';
import type { CoreTurnDeps } from './types.js';

/** Continuation attempts allowed after a token-limit stop before the run blocks honestly. */
export const MAX_LENGTH_CONTINUATIONS = 2;
const LENGTH_BLOCK_REASON = 'run blocked: the model output hit the token limit repeatedly without a complete answer';
const LENGTH_HINT =
  '[internal recovery] Your previous turn was cut off by the output token limit, so it is incomplete and was not ' +
  'delivered to the user. Continue from where it stopped and finish the answer, or re-issue only the truncated call ' +
  'with complete output. Do not repeat the part you already produced.';

export async function lengthDecision(deps: CoreTurnDeps): Promise<SettleDecision> {
  if (deps.lengthBudget.count >= MAX_LENGTH_CONTINUATIONS) {
    await deps.ctx.run(`length-block:${deps.stepIndex}`, async () => {
      await markRunBlocked(deps.services.store, deps.runId, 'limit', LENGTH_BLOCK_REASON);
    });
    return 'blocked';
  }
  deps.lengthBudget.count += 1;
  const key = deps.ctx.rand.uuidv4();
  await deps.ctx.run(`length-hint:${deps.stepIndex}`, async () => {
    await appendToTranscript(deps.services.store, deps.input.sessionKey, [taskHintMessage(LENGTH_HINT)], key);
  });
  return 'continued';
}

