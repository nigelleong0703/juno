import type { EventReceipt, Store } from '../../../contracts/index.js';
import type { ExternalEvent } from '../logic/match.js';

export interface EventScope {
  ownerId: string;
  agentId: string;
  conversationId: string;
}

/** Deterministic receipt id over owner/agent/conversation/source/type/event id. */
export function eventReceiptId(scope: EventScope, source: string, type: string, eventId: string): string {
  return JSON.stringify([scope.ownerId, scope.agentId, scope.conversationId, source, type, eventId]);
}

/** The receipt proving this exact event was already consumed in this scope, if any. */
export function findEventReceipt(
  store: Store,
  scope: EventScope,
  event: ExternalEvent,
): Promise<EventReceipt | null> {
  return store.get('eventReceipts', eventReceiptId(scope, event.source, event.type, event.id));
}

/** A consumption receipt for the finish transaction that deletes the subscription. */
export function receiptFor(scope: EventScope, runId: string, event: ExternalEvent, now: string): EventReceipt {
  return {
    id: eventReceiptId(scope, event.source, event.type, event.id),
    agentId: scope.agentId,
    conversationId: scope.conversationId,
    runId,
    source: event.source,
    type: event.type,
    eventId: event.id,
    consumedAt: now,
    createdAt: now,
  };
}
