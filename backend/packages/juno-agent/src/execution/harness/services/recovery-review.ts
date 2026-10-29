import type { Doc, Store, StoredRequest } from '../../../contracts/index.js';
import { toPublicRequest } from '../../../contracts/index.js';
import { emitItemAdded } from '../../conversation-activity.js';
import { openEffectReview } from '../../../modules/tasks/effect-review.js';
import { boundedSummary, redactText } from './tool-projection.js';
import { recoveryRequestId } from './recovery-ledger.js';
import type { ToolRunContext } from './replay.js';
import type { RunInput } from './run-types.js';

/** One durable review ledger for foreground waits and detached background completion. */
export async function persistRecoveryRequest(
  ctx: ToolRunContext, store: Store, input: Pick<RunInput, 'agentId' | 'conversationId'>,
  runId: string, step: Doc<'steps'>, toolName: string, fingerprint: string, reason: string,
  actionSummary: string, intent: { connectionId?: string; account?: string },
  sourceStepId = step.id, detached = false,
): Promise<StoredRequest> {
  const id = recoveryRequestId(sourceStepId);
  return await ctx.run(`recovery:${step.id}:request`, async () => {
    const existing = await store.get('requests', id);
    if (existing !== null) return existing;
    const createdAt = new Date().toISOString();
    const safeReason = redactText(reason).slice(0, 500);
    const next: StoredRequest = {
      id, kind: 'question', status: 'pending', title: 'Check an uncertain action',
      summary: 'The action may have taken effect, but no trustworthy result was saved.',
      agentId: input.agentId, conversationId: input.conversationId, runId,
      ...(detached ? { interrupted: true, awakeableId: '' } : {}),
      payload: {
        kind: 'question', ui: {
          version: 1, title: 'What did you verify?',
          blocks: [
            { type: 'facts', rows: [
              { label: 'Action', value: boundedSummary(toolName) },
              { label: 'Target and parameters', value: actionSummary },
              { label: 'Attempted at', value: new Date().toISOString() },
            ] },
            { type: 'notice', tone: 'warning', text: `${safeReason} Your answer is recorded as your report, not as a connector receipt.` },
            { type: 'choices', id: 'recovery_outcome', options: [
              { id: 'reported_done', label: 'I checked: it succeeded', description: 'Continue with this as your report; it is not machine verified.' },
              { id: 'confirmed_absent_retry', label: 'I checked: it did not happen', description: 'Authorize one retry, subject to current permissions.' },
              { id: 'still_unknown', label: 'Still unknown', description: 'Keep this action blocked.' },
            ] },
          ],
        } },
      createdAt,
      reconciliation: { stepId: sourceStepId, tool: toolName, fingerprint, reason: safeReason, ...intent, state: 'pending' },
    };
    const item = { id: 'itm_' + id, conversationId: input.conversationId, type: 'request' as const, requestId: id, at: createdAt };
    await store.tx(async (store) => {
      await store.put('requests', next, { conversationId: input.conversationId, runId });
      await store.put('items', item, { conversationId: input.conversationId });
      await store.emit({ type: 'request.created', request: toPublicRequest(next) });
      await emitItemAdded(store, input.conversationId, item);
      // The run now has an uncertain outside action the owner has not settled (its task reads as waiting for the review).
      await openEffectReview(store, runId);
    });
    return next;
  });
}
