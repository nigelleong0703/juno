/**
 * Reading and cleanup for PH9 output artifacts — the read side of outputArtifacts.ts.
 *
 * Authorization is exact: owner AND agent must match, and when the caller asserts a producing run or
 * step it must match too (the id binds owner|run|step, so a mismatch is a binding collision, not a
 * guess). A same-agent read from another run is allowed on purpose: retained outputs belong to the
 * agent, never to an arbitrary owner. Reads alone never bound the store, so expiry is enforced by a
 * bounded, owner-scoped cleanup instead.
 */
import type { Store } from '../../contracts/index.js';

export const ARTIFACT_READ_MAX_CHARS = 20_000;
export const ARTIFACT_READ_DEFAULT_CHARS = 8_000;
/** One cleanup call deletes at most this many expired rows, so it can never sweep unbounded. */
export const ARTIFACT_CLEANUP_LIMIT = 500;

export interface ArtifactReadResult {
  ref: string;
  text: string;
  cursor: number;
  nextCursor: number;
  totalChars: number;
  truncated: boolean;
  originalChars: number;
  expiresAt: string;
}

export type ArtifactReadFailure = 'not_found' | 'denied' | 'expired' | 'bad_cursor';

export async function readOutputArtifact(
  store: Store,
  input: { ownerId: string; agentId: string; ref: string; cursor?: number; maxChars?: number; runId?: string; stepId?: string; now?: number },
): Promise<ArtifactReadResult | ArtifactReadFailure> {
  const artifact = await store.get('artifacts', input.ref);
  if (artifact === null) return 'not_found';
  // Owner and agent must both match; a known run/step must match the artifact's own binding.
  if (artifact.ownerId !== input.ownerId || artifact.agentId !== input.agentId) return 'denied';
  if (input.runId !== undefined && artifact.runId !== input.runId) return 'denied';
  if (input.stepId !== undefined && artifact.stepId !== input.stepId) return 'denied';
  if (Date.parse(artifact.expiresAt) <= (input.now ?? Date.now())) return 'expired';
  const cursor = clamp(input.cursor ?? 0, 0, artifact.text.length);
  // A cursor inside a surrogate pair is rejected, never silently skipped or duplicated.
  if (!pairAligned(artifact.text, cursor)) return 'bad_cursor';
  const maxChars = clamp(input.maxChars ?? ARTIFACT_READ_DEFAULT_CHARS, 1, ARTIFACT_READ_MAX_CHARS);
  const nextCursor = safeSliceEnd(artifact.text, cursor, maxChars);
  return {
    ref: artifact.id,
    text: artifact.text.slice(cursor, nextCursor),
    cursor,
    nextCursor,
    totalChars: artifact.text.length,
    truncated: artifact.truncated,
    originalChars: artifact.originalChars,
    expiresAt: artifact.expiresAt,
  };
}

export interface CleanupResult {
  deleted: number;
  /** Rows examined this call, so a caller can see the bounded work. */
  scanned: number;
  /** Pass back to continue where this call stopped; absent once the scan reached the end. */
  nextCursor?: string;
}

/**
 * Delete this owner's expired artifacts. The scan is OLDEST FIRST (`orderBy:'at'`, the projected
 * `createdAt`) on the owner's own `forOwner` view, so with a constant TTL the expired rows are a
 * prefix and repeated calls make real progress instead of re-reading an arbitrary first page forever.
 * At most `limit` rows are examined per call and the continuation is returned, so it bounds store
 * volume without wiping live data and without claiming a volume bound it cannot keep.
 */
export async function cleanupExpiredArtifacts(store: Store, input: { ownerId: string; now?: number; limit?: number; cursor?: string }): Promise<CleanupResult> {
  const now = input.now ?? Date.now();
  const limit = clamp(input.limit ?? ARTIFACT_CLEANUP_LIMIT, 1, 5_000);
  const owner = store.forOwner?.(input.ownerId) ?? store;
  const page = await owner.list('artifacts', { orderBy: 'at', order: 'asc', limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
  let deleted = 0;
  for (const artifact of page.items) {
    if (artifact.ownerId !== input.ownerId) continue;
    if (Date.parse(artifact.expiresAt) > now) continue;
    await owner.delete('artifacts', artifact.id);
    deleted += 1;
  }
  return { deleted, scanned: page.items.length, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.trunc(value), max));
}

/** True when the cursor sits on a code-unit boundary (not the low half of a surrogate pair). */
function pairAligned(text: string, cursor: number): boolean {
  if (cursor <= 0 || cursor >= text.length) return true;
  const code = text.charCodeAt(cursor);
  return !(code >= 0xdc00 && code <= 0xdfff);
}

/** The end of a window that never splits a surrogate pair, and always makes progress. */
function safeSliceEnd(text: string, cursor: number, maxChars: number): number {
  let end = Math.min(text.length, cursor + maxChars);
  if (end >= text.length || end <= cursor) return end;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end = end - 1 > cursor ? end - 1 : Math.min(text.length, cursor + 2);
  return end;
}
