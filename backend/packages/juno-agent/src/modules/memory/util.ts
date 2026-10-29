import type { Collection, Doc, ListQuery, Store } from '../../contracts/index.js';

/** Read every page of a list query (single-user scale; callers keep `where` tight). */
export async function listAll<C extends Collection>(
  store: Store,
  collection: C,
  query: Omit<ListQuery, 'cursor'> = {},
  max = 10_000,
): Promise<Doc<C>[]> {
  const out: Doc<C>[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(collection, { limit: 500, ...query, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && out.length < max);
  return out;
}
