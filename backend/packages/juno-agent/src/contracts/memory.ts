// ---------------------------------------------------------------------------
// Compaction checkpoint (BACKEND.md §5.9). Agent memory itself is files in the user's home (§5.1); the two
// collections below are its index and its assertions (§5.2).
// ---------------------------------------------------------------------------

import type { MemoryClaim } from '@agent-desktop/public-contracts';

/** One chunk of MEMORY.md, memory/** or people/** with its vector. `id` is `<ownerId>:<path>:<startLine>`; the row's `kind` index is the path. */
export interface MemoryEntry {
  id: string;
  ownerId: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  /** Hash of the whole file when the chunk was made: a changed file replaces all of its chunks. */
  fileHash: string;
  /** The chunk is in a per-agent section of a people page (`## <name>（<agentId>）`): search shows it to that agent only. */
  agentId?: string;
  /** The vector; absent while the embedder is unavailable (search then ranks by keywords alone). Used only when `embedModel` and `dim` match the current embedder, else re-embedded in the background. */
  embedding?: number[];
  /** The model that made `embedding` (a row from before this field existed has none and is re-embedded). */
  embedModel?: string;
  /** Length of `embedding`. */
  dim?: number;
}

/** A stored claim: the public shape plus its owner. The row's `status` index is the claim status. */
export type MemoryClaimDoc = MemoryClaim & { ownerId: string };

/** An old tool result replaced by a short stub at an epoch boundary (BACKEND §3.5.2b): the transcript row keeps the full result, the projection shows `stub`. */
export interface ResultTrim {
  seq: number;
  stub: string;
}

/**
 * A checkpoint of one session's history. A compaction has a `summary` and the `uptoSeq` it covers. A result trim (BACKEND §3.5.2b) is the
 * same kind of epoch boundary without a summary: it carries the earlier checkpoint's fields forward (or `uptoSeq: -1` when there was none)
 * and adds `trims`, so every request after it projects the same stubs and the history is append-only again until the next boundary.
 */
export interface Compaction {
  id: string;
  sessionKey: string;
  epoch: number;
  /** Absent on a checkpoint that only trims results and no compaction came before it. */
  summary?: string;
  uptoSeq: number;
  /** The newest user messages before the cut (text only, within a token budget), kept verbatim ahead of the summary. */
  recentUsers?: string[];
  /** Tool results after `uptoSeq` shown as stubs. Cumulative: each trim keeps the earlier ones. */
  trims?: ResultTrim[];
  createdAt: string;
}
