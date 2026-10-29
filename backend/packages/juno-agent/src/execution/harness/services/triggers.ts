import type { Store, Enqueuer } from '../../../contracts/index.js';
import { sessionKey } from '../../../contracts/index.js';
import { isExpired, matchesFilter, matchSubscriptions, type ExternalEvent } from '../logic/match.js';
import { listAll } from '../../../modules/memory/util.js';
import { docOwner } from '../../execution-owner.js';
import { findEventReceipt } from './event-receipts.js';
import { taskDoneWake } from './completion-wake.js';

/** How long an expired notify subscription is kept so its in-flight timeout notice still counts. */
export const NOTIFY_EXPIRY_GRACE_MS = 24 * 60 * 60_000;

export const createTriggersService = (deps: { store: Store; enqueuer: Enqueuer }) => ({
  async deliverExternal(event: ExternalEvent, scope?: { ownerId: string; agentId: string; conversationId: string }): Promise<{ matched: number; attempted: number; duplicated: number }> {
    const now = Date.now();
    const subscriptions = await listAll(deps.store, 'subscriptions', {}, Infinity);
    // H-87: expired session-level waits (no run waiting on them) are removed when met; a run's own wait is
    // cleaned up by that run's timeout path. A notify wait is kept for a day past expiry, because its
    // timeout notice (H-85) is told apart from a consumed wait by the row still existing.
    for (const expired of subscriptions.filter((s) => s.runId === undefined && isExpired(s, now - (s.notify === true ? NOTIFY_EXPIRY_GRACE_MS : 0)))) {
      await deps.store.delete('subscriptions', expired.id);
    }
    const matched = matchSubscriptions(subscriptions, event, now);

    let delivered = 0;
    let attempted = 0;
    let duplicated = 0;
    for (const sub of matched) {
      // The subscription belongs to whoever created it (the scoped store stamps its owner); its
      // agent is the fallback. A subscription with no owner is skipped rather than defaulted.
      const ownerId = docOwner(sub) ?? docOwner(await deps.store.get('agents', sub.agentId));
      if (ownerId === undefined) continue;
      if (scope !== undefined && (ownerId !== scope.ownerId || sub.agentId !== scope.agentId || sub.conversationId !== scope.conversationId)) continue;
      if (sub.runId !== undefined) {
        // A wait resumes its existing Run; never queue a second run behind it. The row is
        // locked first, then re-read, scope/expiry/filter revalidated and the first event
        // written: concurrent webhooks serialize on the lock so the first event always wins,
        // a wait the Run already finished (deleted) is never resurrected, and an event the
        // original Run already consumed (durable receipt) is acknowledged as a duplicate
        // instead of waking a brand-new Run behind it.
        if (typeof deps.store.getForUpdate !== 'function') {
          throw new Error('Store.getForUpdate is required: refusing unlocked event delivery');
        }
        const outcome = await deps.store.tx(async (tx): Promise<'resumed' | 'duplicate' | false> => {
          const locked = tx.getForUpdate;
          if (locked === undefined) {
            throw new Error('Store.getForUpdate is required: refusing unlocked event delivery');
          }
          const fresh = await locked('subscriptions', sub.id);
          if (fresh === null) {
            // The wait is gone: only a consumption receipt proves this exact event was
            // already handled. Anything else falls through to a fresh wake below.
            const goneOwner = docOwner(sub) ?? docOwner(await tx.get('agents', sub.agentId));
            if (goneOwner === undefined) return false;
            const receiptScope = scope ?? { ownerId: goneOwner, agentId: sub.agentId, conversationId: sub.conversationId };
            return (await findEventReceipt(tx, receiptScope, event)) === null ? false : 'duplicate';
          }
          if (fresh.runId !== sub.runId) return false;
          const freshOwner = docOwner(fresh) ?? docOwner(await tx.get('agents', fresh.agentId));
          if (freshOwner === undefined) return false;
          if (scope !== undefined && (freshOwner !== scope.ownerId || fresh.agentId !== scope.agentId || fresh.conversationId !== scope.conversationId)) return false;
          if (isExpired(fresh, Date.now())) return false;
          if (!matchesFilter(fresh.filter, event)) return false;
          // Already consumed by an earlier Run in this scope (e.g. a redelivery racing a new
          // wait): never re-patch a live wait with history.
          const liveScope = { ownerId: freshOwner, agentId: fresh.agentId, conversationId: fresh.conversationId };
          if ((await findEventReceipt(tx, liveScope, event)) !== null) return 'duplicate';
          if (fresh.event !== undefined) return 'resumed';
          await tx.patch('subscriptions', fresh.id, { event });
          return 'resumed';
        });
        if (outcome === 'resumed') {
          attempted += 1;
          delivered += 1;
        } else if (outcome === 'duplicate') {
          duplicated += 1;
        }
        continue;
      }
      attempted += 1;
      if (sub.notify === true) {
        // H-69 notify mode: one task_done for the first matching event (the id dedupes any redelivery),
        // then the subscription ends.
        const summary = JSON.stringify({ source: event.source, type: event.type, id: event.id, data: event.data ?? {} }).slice(0, 2000);
        const done = taskDoneWake(
          { ownerId, agentId: sub.agentId, conversationId: sub.conversationId },
          { taskId: sub.id, taskKind: 'event', status: 'completed', summary, ...(sub.generation === undefined ? {} : { generation: sub.generation }), ...(sub.originRunId === undefined ? {} : { originRunId: sub.originRunId }) },
          new Date().toISOString(),
        );
        const admitted = await deps.enqueuer.enqueue(done);
        if (admitted.accepted) {
          delivered += 1;
          await deps.store.delete('subscriptions', sub.id);
        }
        continue;
      }
      const wake = {
        id: `wake_webhook_${event.id}_${sub.id}`,
        ownerId,
        agentId: sub.agentId,
        sessionKey: sessionKey(sub.agentId, sub.conversationId ?? sub.agentId),
        conversationId: sub.conversationId,
        kind: 'connector_event' as const,
        origin: { type: 'automation' as const, label: event.source },
        trusted: false,
        priority: 'background' as const,
        payload: event,
        at: new Date().toISOString(),
        status: 'accepted' as const,
      };

      const result = await deps.enqueuer.enqueue(wake);
      if (result.accepted) delivered += 1;
    }

    // No live wait matched: a retry arriving after the original Run consumed the event and
    // deleted its wait still carries the caller scope, so the durable receipt answers it.
    if (attempted === 0 && duplicated === 0 && scope !== undefined) {
      if ((await findEventReceipt(deps.store, scope, event)) !== null) duplicated = 1;
    }

    return { matched: delivered, attempted, duplicated };
  },
});
