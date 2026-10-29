/**
 * File bytes at rest (BACKEND §5.2a): uploads, sent files, artifact files and previews, approval screenshots and the
 * images of transcript rows live in a blob store, never in a Postgres document. A document keeps only metadata
 * (name, mimeType, sizeBytes, sha256, blobKey). Keys are content-addressed (`blobs/<sha256>`), so the same bytes are
 * stored once however many rows name them. Downloads stay proxied through the API (owner checks), so there are no
 * signed URLs. Implementations (local directory, S3-compatible bucket) live in the host (packages/db).
 */
import { createHash } from 'node:crypto';

export interface BlobStore {
  /** Store `bytes` under `key`; writing the same key again is a no-op for content-addressed keys. */
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  /** The bytes, or null when no object has this key. */
  get(key: string): Promise<Buffer | null>;
  /** Remove the object; a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** What a document records about bytes it keeps in the blob store. */
export interface BlobRef {
  blobKey: string;
  sizeBytes: number;
  sha256: string;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const blobKeyFor = (sha256: string): string => `blobs/${sha256}`;

/** Put bytes under their content address and return the reference a document stores. */
export async function saveBlob(blobs: BlobStore, bytes: Uint8Array, mimeType: string): Promise<BlobRef> {
  const sha256 = sha256Hex(bytes);
  const blobKey = blobKeyFor(sha256);
  await blobs.put(blobKey, bytes, mimeType);
  return { blobKey, sizeBytes: bytes.length, sha256 };
}

export type BlobRead = { ok: true; bytes: Buffer } | { ok: false; reason: string };

/** Read the bytes a document names, after the size and sha256 checks every stored file must pass. */
export async function loadBlob(blobs: BlobStore, ref: { blobKey?: string; sizeBytes: number; sha256?: string }): Promise<BlobRead> {
  if (typeof ref.blobKey !== 'string') return { ok: false, reason: 'no stored content' };
  const bytes = await blobs.get(ref.blobKey);
  if (bytes === null) return { ok: false, reason: 'the stored file is missing' };
  if (bytes.length !== ref.sizeBytes) return { ok: false, reason: 'stored bytes do not match their recorded size' };
  if (typeof ref.sha256 === 'string' && sha256Hex(bytes) !== ref.sha256) return { ok: false, reason: 'stored bytes failed their integrity check' };
  return { ok: true, bytes };
}
