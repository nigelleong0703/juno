import type { Item } from "@agent-desktop/client";

/**
 * Chronological ordering for a conversation's items.
 *
 * `Item` carries `at` (an ISO-8601 instant) but no sequence number, and the items endpoint can
 * return entries out of order: owner feedback 2026-10-05 saw an agent reply stamped *earlier* than
 * a later one arrive last, so the reply rendered after an answer that came after it. Ordering is
 * therefore settled on the client, by `at`, without rewriting the stored data — reads sort the
 * fetched list (`queries.useItems`) and the live stream inserts into the same order (`liveSync`).
 */

/** Epoch ms for an item's `at`; an unparseable stamp sorts first but keeps its relative place. */
function timestamp(item: Item): number {
  const value = Date.parse(item.at);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * A new array of `items` ordered by `at` ascending. `Array.prototype.sort` is stable, so items
 * that share an instant keep the order they arrived in.
 */
export function sortItemsChronologically(items: Item[]): Item[] {
  return [...items].sort((a, b) => timestamp(a) - timestamp(b));
}

/**
 * Fold one item into a chronological list: replace an existing entry with the same id, otherwise
 * add it, and re-sort so an item delivered late still lands in its own place.
 */
export function mergeItemChronologically(items: Item[], item: Item): Item[] {
  return sortItemsChronologically([...items.filter((entry) => entry.id !== item.id), item]);
}

/**
 * Swap an optimistic placeholder for the server's stored item: drops the temp entry,
 * then merges by id, so a live echo that arrived first is replaced rather than
 * duplicated and a missing echo still converges.
 */
export function replaceOptimisticItem(items: Item[], tempId: string, item: Item): Item[] {
  return mergeItemChronologically(
    items.filter((entry) => entry.id !== tempId),
    item,
  );
}
