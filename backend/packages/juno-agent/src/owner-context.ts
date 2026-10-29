/**
 * Request owner boundary: pure AsyncLocalStorage half (juno-agent).
 *
 * The single AsyncLocalStorage instance for the owner scope lives here. The
 * host re-exports these helpers so HTTP and execution share exactly one
 * ownerContext. Hono and workspace HTTP helpers stay in the host.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Collection,
  Doc,
  IndexedFields,
  ListPage,
  ListQuery,
  Store,
} from './contracts/index.js';
import type { AgentEvent } from '@agent-desktop/public-contracts';

export class OwnerScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerScopeError';
  }
}

export const ownerContext = new AsyncLocalStorage<string>();

/** Enter the request owner scope; every nested await keeps it (concurrent requests stay apart). */
export function runWithOwner<T>(ownerId: string, fn: () => T): T {
  return ownerContext.run(ownerId, fn);
}

/** Owner on this async chain, if any. */
export function currentOwnerId(): string | undefined {
  return ownerContext.getStore();
}

function isPresentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Request owner with no fallback: the ALS context wins, then the explicit caller value
 * (today: the bearer-auth context). Empty and missing both throw.
 */
export function requireOwnerId(explicit?: unknown): string {
  const fromContext = currentOwnerId();
  if (isPresentId(fromContext)) return fromContext;
  if (isPresentId(explicit)) return explicit;
  throw new OwnerScopeError('missing owner context: account HTTP requires an authenticated owner');
}

/**
 * Request dependency facade. Wraps the raw store once at mount time so every reader sees the
 * request owner scope without handler changes: when the ALS owner is present every call
 * delegates to that owner's scoped store, otherwise it falls through to the raw backend
 * (background work and owner-less test fixtures keep working).
 */
export function requestScopedStore(base: Store): Store {
  const target = (): Store => {
    const owner = currentOwnerId();
    if (owner && typeof base.forOwner === 'function') return base.forOwner(owner);
    return base;
  };
  return {
    forOwner(next: string): Store {
      if (typeof base.forOwner !== 'function') {
        throw new OwnerScopeError('Store.forOwner is required: refusing unscoped account access');
      }
      return base.forOwner(next);
    },
    tx<T>(fn: (store: Store) => Promise<T>): Promise<T> {
      return target().tx(fn);
    },
    get<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      return target().get(collection, id);
    },
    async getForUpdate<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> {
      const scoped = target();
      if (typeof scoped.getForUpdate !== 'function') {
        throw new OwnerScopeError('Store.getForUpdate is required: refusing unlocked row access');
      }
      return scoped.getForUpdate(collection, id);
    },
    list<C extends Collection>(collection: C, query?: ListQuery): Promise<ListPage<Doc<C>>> {
      return target().list(collection, query);
    },
    put<C extends Collection>(collection: C, doc: Doc<C>, index?: IndexedFields): Promise<Doc<C>> {
      return target().put(collection, doc, index);
    },
    patch<C extends Collection>(collection: C, id: string, patch: Partial<Doc<C>>): Promise<Doc<C>> {
      return target().patch(collection, id, patch);
    },
    delete(collection: Collection, id: string): Promise<void> {
      return target().delete(collection, id);
    },
    emit(event: AgentEvent): Promise<void> {
      return target().emit(event);
    },
  };
}
