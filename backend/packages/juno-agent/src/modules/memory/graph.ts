/**
 * The Postgres parts of memory (BACKEND §5.4, §9.5, §9.6): the memory items, which are the source of truth, the identity graph that
 * names their people, and the relations between those people. A deployment has all or none (they need the database), so they travel together.
 */
import type { Identity } from '@agent-desktop/memory-graph/identity';
import type { MemoryItems } from '@agent-desktop/memory-graph/memory';
import type { Relations } from '@agent-desktop/memory-graph/relations';
import type { Embedder } from './embedder.js';

export interface MemoryGraph {
  items: MemoryItems;
  identity: Identity;
  relations: Relations;
  /** Vectors for the items and the query (memory_search, the memory section). Absent: words only. */
  embedder?: Embedder;
}
