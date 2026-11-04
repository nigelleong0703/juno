/**
 * Deleting stored bytes together with the rows that named them (BACKEND §5.2a, §5.2c). Blobs are content-addressed and one object can
 * be named by many rows, so bytes go only when no row that stays names them. The account wipe and the single-agent delete both come here.
 */
import type { BlobStore } from '@agent-desktop/contracts';
import { blobKeysStillNamed } from '@agent-desktop/db';
import type { DurableDb } from '@agent-desktop/durable';

/** Every `blobKey` string anywhere in a stored document (uploads, artifact files, transcript image blocks). */
export function collectBlobKeys(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 12 || typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectBlobKeys(item, into, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'blobKey' && typeof item === 'string' && item.startsWith('blobs/')) into.add(item);
    else collectBlobKeys(item, into, depth + 1);
  }
}

/**
 * Delete the objects of `keys` that no row still names. `exceptOwner` leaves that owner's rows out of the check (the account wipe,
 * which runs while the owner's rows are still there); without it every remaining row counts (rows already deleted by the caller).
 */
export async function deleteUnnamedBlobs(raw: DurableDb, blobs: BlobStore, keys: ReadonlySet<string>, exceptOwner?: string): Promise<{ found: number; deleted: number; keptBecauseShared: number }> {
  const named = await blobKeysStillNamed(raw, [...keys], exceptOwner);
  let deleted = 0;
  for (const key of keys) {
    if (named.has(key)) continue;
    await blobs.delete(key);
    deleted += 1;
  }
  return { found: keys.size, deleted, keptBecauseShared: named.size };
}
