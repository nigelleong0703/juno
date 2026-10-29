import type { Collection, Doc, Store } from './storage.js';

/**
 * Compare-and-set on one document, enforced by the database row lock.
 *
 * Execution workers and the coordinator are separate processes, so "read the status, then patch it" lets a
 * worker's close and the coordinator's decision both succeed and the later write silently win. Here the row is
 * locked (`SELECT ... FOR UPDATE` inside a transaction), `accept` sees the current document, and the patch is applied
 * only when it returns true. Returns the patched document, or `undefined` when the row is gone or `accept` refused it
 * (the caller then re-reads whatever won).
 */
export async function patchWhen<C extends Collection>(
  store: Store,
  collection: C,
  id: string,
  accept: (current: Doc<C>) => boolean,
  patch: Partial<Doc<C>>,
): Promise<Doc<C> | undefined> {
  return store.tx(async (tx) => {
    if (tx.getForUpdate === undefined) throw new Error('patchWhen needs a store with row locks (getForUpdate)');
    const current = await tx.getForUpdate(collection, id);
    if (current === null || !accept(current)) return undefined;
    return tx.patch(collection, id, patch);
  });
}
