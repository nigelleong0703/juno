/**
 * The memory assembly (BACKEND §2.4): the memory items, the identity graph and the relations over Postgres, the embedder's vector
 * writer, and the port the agent runtime reads and writes through. agentd builds it once at boot (and serves the port in-process, or
 * hands it to memoryd's server when memoryd runs separately); memoryd builds the same assembly for its own process. Without Postgres
 * there is no memory, and `createMemoryModule` returns undefined.
 */
import type { DurableDb } from '@agent-desktop/durable';
import { createIdentity } from '@agent-desktop/memory-graph/identity';
import { createMemoryItems } from '@agent-desktop/memory-graph/memory';
import { createRelations } from '@agent-desktop/memory-graph/relations';
import type { Store } from '../../contracts/index.js';
import type { HomeComputer } from '../../ports/computer/index.js';
import type { Embedder } from './embedder.js';
import type { MemoryGraph } from './graph.js';
import { createMemoryPort, type MemoryPort } from './port.js';
import { backfillVectors, createVectorWriter, type VectorWriter } from './vectors.js';

export interface MemoryLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface MemoryModuleDeps {
  store: Store;
  /** Postgres. Without it there is no memory at all. */
  raw?: DurableDb;
  /** The hosted embeddings (EMBEDDING_*); absent: memory is searched by words only. */
  embedder?: Embedder;
  /** The computer's home, where the views are written. */
  home?: HomeComputer;
  log?: MemoryLog;
}

export interface MemoryModule {
  /** The concrete graph. Only the boot's migrations, the memory jobs and the goal briefing read it; the runtime reads `port`. */
  graph: MemoryGraph;
  /** What the agent runtime and the HTTP routes depend on. */
  port: MemoryPort;
  /** Embeds each item soon after it is written; absent without an embedder. */
  vectorWriter?: VectorWriter;
  /** Begins the background work once the boot's migrations have run: the vector backfill for items without a vector. */
  start(): void;
  /** Stops embedding what is queued. The items keep no vector, and the next boot's backfill embeds them. */
  stop(): void;
}

export function createMemoryModule(deps: MemoryModuleDeps): MemoryModule | undefined {
  const { raw, embedder, log } = deps;
  if (raw === undefined) return undefined;
  // An item is embedded soon after it is written: the hook queues it on the writer, which is made below.
  let vectors: VectorWriter | undefined;
  const items = createMemoryItems(raw, { onWritten: (ownerId, id, text) => vectors?.onWritten(ownerId, id, text) });
  const identity = createIdentity(raw);
  const relations = createRelations(raw);
  const graph: MemoryGraph = { items, identity, relations, ...(embedder === undefined ? {} : { embedder }) };
  if (embedder !== undefined) vectors = createVectorWriter({ items, embedder, ...(log === undefined ? {} : { log: (fields, message) => log.warn(fields, message) }) });
  const port = createMemoryPort({ store: deps.store, graph, ...(deps.home === undefined ? {} : { home: deps.home }) });
  return {
    graph,
    port,
    ...(vectors === undefined ? {} : { vectorWriter: vectors }),
    start() {
      if (embedder === undefined) return;
      void backfillVectors({ items, embedder })
        .then((stored) => { if (stored > 0) log?.info({ stored }, 'Embedded memory items (vector backfill)'); })
        .catch((error: unknown) => log?.error({ err: error }, 'Memory vector backfill failed; the next boot retries it'));
    },
    stop() {
      vectors?.stop();
    },
  };
}
