/**
 * Vectors for the memory items (BACKEND §5.4, batch 5a). An item is embedded soon after its text is written: the writes queue up and go
 * to the embedder together, EMBED_BATCH at a time, off the write's own path. At boot the items with no vector from the current model are
 * embedded in batches until none is left. Without an embedder nothing is stored and items are ranked by words alone.
 */
import type { MemoryItems, OnItemWritten } from '@agent-desktop/memory-graph/memory';
import { EMBED_BATCH, type Embedder } from './embedder.js';

type Log = (fields: Record<string, unknown>, message: string) => void;

/** The writes of one burst are embedded together: this long after the first of them. */
const FLUSH_DELAY_MS = 300;

interface Pending {
  ownerId: string;
  id: string;
  text: string;
}

/**
 * Embeds one batch and stores each vector against its item's text (a text changed meanwhile keeps none). The count stored, or -1 when
 * the embedder did not answer. A vector of another length than the embedder asks for is not stored.
 */
async function embedBatch(items: MemoryItems, embedder: Embedder, batch: readonly Pending[]): Promise<number> {
  const vectors = await embedder.embed(batch.map((entry) => entry.text));
  if (vectors === null) return -1;
  let stored = 0;
  for (const [index, entry] of batch.entries()) {
    const embedding = vectors[index];
    if (embedding === undefined || (embedder.dimensions !== undefined && embedding.length !== embedder.dimensions)) continue;
    if (await items.setVector(entry.ownerId, entry.id, entry.text, { embedding, embedModel: embedder.model })) stored += 1;
  }
  return stored;
}

export interface VectorWriter {
  /** The hook for the memory items: a text was written, so it is queued. Never throws, never waits. */
  onWritten: OnItemWritten;
  /** Embeds what is queued now; resolves when that is done (tests, shutdown). */
  flush(): Promise<void>;
  /** Drops what is queued and its timer: no batch starts after this. The items keep no vector; the next boot's backfill embeds them. */
  stop(): void;
}

/**
 * A write whose embedding fails is not retried here: the item keeps no vector and the next boot's backfill embeds it. The embedder has
 * its own cooldown, so an outage costs one failed call per burst, not one per item.
 */
export function createVectorWriter(opts: { items: MemoryItems; embedder: Embedder; log?: Log; delayMs?: number }): VectorWriter {
  const pending = new Map<string, Pending>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const drain = async (): Promise<void> => {
    while (pending.size > 0) {
      const batch = [...pending.values()].slice(0, EMBED_BATCH);
      for (const entry of batch) pending.delete(entry.ownerId + '\n' + entry.id);
      const stored = await embedBatch(opts.items, opts.embedder, batch).catch((error: unknown) => {
        opts.log?.({ err: error instanceof Error ? error.message : String(error) }, 'memory item embedding failed; the boot backfill embeds it later');
        return -1;
      });
      if (stored < 0) {
        pending.clear();
        return;
      }
    }
  };

  const start = (): void => {
    timer = undefined;
    running = running.then(drain).catch((error: unknown) => {
      opts.log?.({ err: error instanceof Error ? error.message : String(error) }, 'memory item embedding stopped');
    });
  };

  return {
    onWritten(ownerId, id, text) {
      pending.set(ownerId + '\n' + id, { ownerId, id, text });
      if (timer === undefined) {
        timer = setTimeout(start, opts.delayMs ?? FLUSH_DELAY_MS);
        timer.unref();
      }
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        start();
      }
      await running;
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

/**
 * Embeds every item that has no vector from the embedder's model (a model change, the first run, or items written while the embedder
 * was down). Batch by batch, oldest first; it stops when the embedder does not answer or a batch stores nothing. Returns how many
 * vectors were stored. All state is in the rows, so a later call resumes where this one stopped.
 */
export async function backfillVectors(opts: { items: MemoryItems; embedder: Embedder }): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await opts.items.itemsNeedingVector(opts.embedder.model, EMBED_BATCH);
    if (rows.length === 0) return total;
    const stored = await embedBatch(opts.items, opts.embedder, rows.map((row) => ({ ownerId: row.ownerId, id: row.id, text: row.text })));
    if (stored <= 0) return total;
    total += stored;
  }
}
