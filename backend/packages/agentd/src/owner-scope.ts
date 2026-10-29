/**
 * Request owner boundary for account HTTP (AU2).
 *
 * The authenticated owner travels on AsyncLocalStorage: auth (or the future runAsOwner hook)
 * enters runWithOwner once per request, and every account-mode reader resolves its Store and
 * EventBus through ownerStore/ownerBus. Anything without an owner or without a forOwner
 * implementation fails closed instead of touching the raw store. The raw store stays available
 * only for the internal runner.
 */
import type { Context } from 'hono';
import type {
  EventBus,
  Store,
  StoredEvent,
} from '@agent-desktop/contracts';
import {
  currentOwnerId,
  OwnerScopeError,
  ownerContext,
  requestScopedStore,
  requireOwnerId,
  runWithOwner,
} from 'juno-agent/owner-context';

export {
  currentOwnerId,
  OwnerScopeError,
  ownerContext,
  requestScopedStore,
  requireOwnerId,
  runWithOwner,
};

/** Owner for the current request: ALS context first, then the auth context. Throws when absent. */
export function requestOwnerId(c: Context): string {
  return requireOwnerId(c.get('ownerId'));
}

/** Owner-scoped store; throws when the owner or Store.forOwner is missing. */
export function ownerStore(deps: { store: Store }, ownerId?: unknown): Store {
  const owner = requireOwnerId(ownerId);
  if (typeof deps.store.forOwner !== 'function') {
    throw new OwnerScopeError('Store.forOwner is required: refusing unscoped account access');
  }
  return deps.store.forOwner(owner);
}

/** Owner-filtered replay/live bus; throws when the owner or EventBus.forOwner is missing. */
export function ownerBus(deps: { bus: EventBus }, ownerId?: unknown): EventBus {
  const owner = requireOwnerId(ownerId);
  if (typeof deps.bus.forOwner !== 'function') {
    throw new OwnerScopeError('EventBus.forOwner is required: refusing unscoped account access');
  }
  return deps.bus.forOwner(owner);
}

/**
 * Owner-scoped reads are the whole point of the account boundary. Refuse to start a service on
 * raw stores instead of silently serving cross-owner data: the caller fails closed at wiring time.
 */
export function requireAccountStores(deps: { store: Store; bus: EventBus }): void {
  if (typeof deps.store.forOwner !== 'function' || typeof deps.bus.forOwner !== 'function') {
    throw new OwnerScopeError(
      'Store.forOwner and EventBus.forOwner are required: refusing unscoped account access',
    );
  }
}

/** Raw store for auth workspace provisioning; never use for account-mode reads or writes. */
export function rawStore(deps: { store: Store }): Store {
  return deps.store;
}

/** Raw bus for internal subscribers; account SSE must use ownerBus. */
export function rawBus(deps: { bus: EventBus }): EventBus {
  return deps.bus;
}


/** Live-event half of the request facade: same ALS delegation, explicit forOwner stays strict. */
export function requestScopedBus(base: EventBus): EventBus {
  const target = (): EventBus => {
    const owner = currentOwnerId();
    if (owner && typeof base.forOwner === 'function') return base.forOwner(owner);
    return base;
  };
  return {
    forOwner(ownerId: string): EventBus {
      if (typeof base.forOwner !== 'function') {
        throw new OwnerScopeError('EventBus.forOwner is required: refusing unscoped account access');
      }
      return base.forOwner(ownerId);
    },
    since(afterId: number, limit?: number): Promise<StoredEvent[]> {
      return target().since(afterId, limit);
    },
    // Global id counter: the head is not owner-filtered (see EventBus.head).
    head(): Promise<number> {
      if (!base.head) throw new OwnerScopeError('EventBus.head is required for the events cursor');
      return base.head();
    },
    subscribe(onEvent: (e: StoredEvent) => void): Promise<() => void> {
      return target().subscribe(onEvent);
    },
    // Retention is global, not per owner.
    prune(before: Date): Promise<number> {
      return base.prune(before);
    },
  };
}
