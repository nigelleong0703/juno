/**
 * Search over what one presence may see (BACKEND §5.3, batch 5a). The items are filtered first (`memoryFor`, in SQL) and only then
 * ranked: words (BM25) and, when the items and the query have vectors from the current embedder, cosine, merged by reciprocal rank.
 * Nothing outside the filtered set is ever ranked or embedded. Without an embedder, or when it does not answer, the words alone rank.
 */
import type { Presence, VisibleItem } from '@agent-desktop/memory-graph/memory';
import type { Embedder } from './embedder.js';
import type { MemoryGraph } from './graph.js';
import { rankEntries } from './rank.js';

export const DEFAULT_HITS = 8;

/** The item's stored vector when the current embedder made it (same model, and the length it asks for); else undefined. */
export function usableVector(item: VisibleItem, embedder: Embedder | undefined): number[] | undefined {
  const vector = item.vector;
  if (embedder === undefined || vector === undefined || vector === null || vector.embedModel !== embedder.model) return undefined;
  if (embedder.dimensions !== undefined && vector.embedding.length !== embedder.dimensions) return undefined;
  return vector.embedding;
}

/**
 * The best `limit` of `items` for `query`, with their scores. `items` must already be one presence's own (from `memoryFor`): this
 * ranks exactly what it is given. The query is embedded only when some item has a usable vector.
 */
export async function rankItems(embedder: Embedder | undefined, items: readonly VisibleItem[], query: string, limit: number): Promise<Array<{ item: VisibleItem; score: number }>> {
  if (items.length === 0 || query.trim() === '') return [];
  const queryVector = embedder !== undefined && items.some((item) => usableVector(item, embedder) !== undefined)
    ? (await embedder.embed([query]))?.[0]
    : undefined;
  const byId = new Map(items.map((item) => [item.id, item]));
  const rankable = items.map((item) => {
    const embedding = queryVector === undefined ? undefined : usableVector(item, embedder);
    return { id: item.id, text: item.text, ...(embedding === undefined ? {} : { embedding }) };
  });
  return rankEntries(query, rankable, queryVector, limit).flatMap((hit) => {
    const item = byId.get(hit.id);
    return item === undefined ? [] : [{ item, score: hit.score }];
  });
}

/** The owner's items one presence may see, ranked for `query`: what memory_search and the app's search return. */
export async function searchMemory(
  memory: MemoryGraph,
  input: { ownerId: string; presence: Presence; agentId: string | undefined; query: string; limit?: number },
): Promise<Array<{ item: VisibleItem; score: number }>> {
  const items = await memory.items.memoryFor(input.ownerId, input.presence, input.agentId, { vectors: memory.embedder !== undefined });
  return rankItems(memory.embedder, items, input.query, input.limit ?? DEFAULT_HITS);
}
