/**
 * `StoredRun.effectReview` (BACKEND 6.5): a run that has an uncertain outside action (a recovery review card the owner
 * has not settled) reads as waiting for that review while it lives and as `unknown_effect` after it ends. The flag is
 * written in the same transaction as the request that opens or settles the review, and the run's task is announced.
 */
import type { Store, StoredRequest } from '../../contracts/index.js';
import { emitRunTask } from './agent-tasks.js';

async function setEffectReview(store: Store, runId: string, state: 'open' | 'resolved'): Promise<void> {
  const run = await store.get('runs', runId);
  if (run === null || run.effectReview === state) return;
  await emitRunTask(store, await store.patch('runs', runId, { effectReview: state }));
}

/** A review card was created for this run's action: the run has an unsettled uncertain action. */
export async function openEffectReview(store: Store, runId: string): Promise<void> {
  await setEffectReview(store, runId, 'open');
}

/**
 * The owner answered a review card (`request` is the decided row). The run stays `open` while any of its review cards is
 * unsettled: this answer was "still unknown", or another card is still pending or was left unknown.
 */
export async function settleEffectReview(store: Store, request: StoredRequest): Promise<void> {
  const own = request.reconciliation;
  if (own === undefined || request.runId === undefined) return;
  let open = own.state === 'pending' || own.state === 'still_unknown';
  if (!open) {
    const siblings = await store.list('requests', { where: { runId: request.runId }, limit: 200 });
    open = siblings.items.some((other) => other.id !== request.id && (other.reconciliation?.state === 'pending' || other.reconciliation?.state === 'still_unknown'));
  }
  await setEffectReview(store, request.runId, open ? 'open' : 'resolved');
}
