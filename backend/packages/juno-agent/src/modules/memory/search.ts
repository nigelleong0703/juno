/**
 * Search over what one presence may see (BACKEND §5.3, §5.4). The visible items are read first (`memoryFor`, in SQL) and ranked by words
 * (BM25, in JS: it needs the corpus); the meaning side is one SQL query, `ORDER BY embedding <=> q LIMIT k` over the same visible rows
 * (pgvector, HNSW). The two orders merge by reciprocal rank (rank.ts). Nothing outside the visible set is ever ranked or returned.
 * Without an embedder, or when it does not answer, the words alone rank.
 */
import type { Presence, VisibleItem } from '@agent-desktop/memory-graph/memory';
import type { MemoryGraph } from './graph.js';
import { MIN_COSINE, rankEntries } from './rank.js';

export const DEFAULT_HITS = 8;

/** How many nearest items the vector query returns to the merge; more than any caller shows, so a word-only match still ranks among them. */
const VECTOR_CANDIDATES = 50;

/**
 * The ids closest to `query` by meaning, closest first and cut at MIN_COSINE; undefined when there is no vector search (no embedder, or
 * it did not answer). `restrictTo` limits it to those ids (callers that rank a subset of the visible items).
 */
export type VectorSearch = (query: string, restrictTo?: readonly string[]) => Promise<string[] | undefined>;

/** The vector search over what `scope` may see, or undefined without an embedder. A vector of the wrong length is an error, not a silent fallback. */
export function vectorSearchFor(memory: MemoryGraph, scope: { ownerId: string; presence: Presence; agentId: string | undefined }): VectorSearch | undefined {
  const { embedder } = memory;
  if (embedder === undefined) return undefined;
  return async (query, restrictTo) => {
    const embedding = (await embedder.embed([query]))?.[0];
    if (embedding === undefined) return undefined;
    const hits = await memory.items.nearest(scope.ownerId, scope.presence, scope.agentId, { embedding, embedModel: embedder.model }, {
      limit: VECTOR_CANDIDATES,
      ...(restrictTo === undefined ? {} : { ids: restrictTo }),
    });
    return hits.filter((hit) => hit.cosine >= MIN_COSINE).map((hit) => hit.id);
  };
}

/**
 * The best `limit` of `items` for `query`, with their scores. `items` must already be one presence's own (from `memoryFor`): this
 * ranks exactly what it is given. The vector query is limited to those items' ids, unless `restrict` is false (the items are all the
 * presence sees, and the query then scans the visible rows, which is what the index serves).
 */
export async function rankItems(
  vectors: VectorSearch | undefined,
  items: readonly VisibleItem[],
  query: string,
  limit: number,
  options: { restrict?: boolean } = {},
): Promise<Array<{ item: VisibleItem; score: number }>> {
  if (items.length === 0 || query.trim() === '') return [];
  const order = await vectors?.(query, options.restrict === false ? undefined : items.map((item) => item.id));
  const byId = new Map(items.map((item) => [item.id, item]));
  return rankEntries(query, items.map((item) => ({ id: item.id, text: item.text })), order, limit).flatMap((hit) => {
    const item = byId.get(hit.id);
    return item === undefined ? [] : [{ item, score: hit.score }];
  });
}

/** The owner's items one presence may see, ranked for `query`: what memory_search and the app's search return. */
export async function searchMemory(
  memory: MemoryGraph,
  input: { ownerId: string; presence: Presence; agentId: string | undefined; query: string; limit?: number },
): Promise<Array<{ item: VisibleItem; score: number }>> {
  const items = await memory.items.memoryFor(input.ownerId, input.presence, input.agentId);
  return rankItems(vectorSearchFor(memory, input), items, input.query, input.limit ?? DEFAULT_HITS, { restrict: false });
}
