/** In-memory BlobStore for tests (production uses packages/db's local directory or S3 store). */
import type { BlobStore } from '../contracts/blobs.js';

export function createMemoryBlobStore(): BlobStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },
    async get(key) {
      const found = objects.get(key);
      return found === undefined ? null : Buffer.from(found);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}
