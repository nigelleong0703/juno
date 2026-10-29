/** A throwaway Postgres for the memory tests: the memory items, the identity graph and the relations over it, as production wires them. */
import { createIdentity } from '@agent-desktop/memory-graph/identity';
import { createMemoryItems } from '@agent-desktop/memory-graph/memory';
import { createRelations } from '@agent-desktop/memory-graph/relations';
import { startTestDatabase } from '@agent-desktop/memory-graph/testing';
import type { DurableDb } from '@agent-desktop/durable';
import type { Store } from '../../../contracts/index.js';
import type { MemoryGraph } from '../graph.js';
import { createMemoryPort, type MemoryPort } from '../port.js';

export interface MemoryGraphFixture {
  db: DurableDb;
  graph: MemoryGraph;
  close(): Promise<void>;
}

export async function startMemoryGraph(): Promise<MemoryGraphFixture> {
  const database = await startTestDatabase();
  return {
    db: database.db,
    graph: { items: createMemoryItems(database.db), identity: createIdentity(database.db), relations: createRelations(database.db) },
    close: database.close,
  };
}

/** The runtime's port over this fixture's graph, with the test's store (what the tools read through the port). */
export const portOf = (fixture: MemoryGraphFixture, store: Store): MemoryPort => createMemoryPort({ store, graph: fixture.graph });

/** A fresh owner id: the database keeps rows between tests, so each test owns its own. */
export const freshOwnerId = (): string => 'owner-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
