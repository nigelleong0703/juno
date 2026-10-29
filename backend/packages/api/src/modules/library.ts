/** Library module: the owner's saved artifacts, read and mutated through the owner scope. */
import { randomUUID } from 'node:crypto';
import { loadBlob, saveBlob, type BlobStore, type LibraryDocument, type ListPage, type ListQuery, type Store } from '@agent-desktop/contracts';
import { fileDownloadSchema, imageSize, libraryItemSchema, MAX_UPLOAD_BYTES } from '@agent-desktop/public-contracts';
import { createArtifactsModule } from './artifacts.js';
import type { Attachment, FileDownload, LibraryItem, UploadInput } from '@agent-desktop/public-contracts';

const MAX_FILE_BYTES = MAX_UPLOAD_BYTES;

export interface LibraryModule {
  list(query: ListQuery): Promise<ListPage<LibraryItem>>;
  get(id: string): Promise<LibraryItem | null>;
  setPinned(id: string, pinned: boolean): Promise<LibraryItem>;
  remove(id: string): Promise<void>;
  download(id: string): Promise<LibraryDownloadResult>;
  upload(input: UploadInput, ownerId: string): Promise<UploadResult>;
}

export type UploadResult = { status: 'ok'; attachment: Attachment } | { status: 'invalid'; reason: string } | { status: 'too_large' };

export type LibraryDownloadResult =
  | { status: 'ok'; file: FileDownload }
  | { status: 'not_found' }
  | { status: 'unavailable'; reason: string };

export function createLibraryModule(scoped: Store, blobs: BlobStore): LibraryModule {
  return {
    async list(query: ListQuery): Promise<ListPage<LibraryItem>> {
      const conversationId = query.where?.conversationId;
      if (typeof conversationId === 'string') {
        const conversation = await scoped.get('conversations', conversationId);
        if (conversation === null) return { items: [] };
      }
      const page = await scoped.list('library', query);
      return { items: page.items.map(stripPrivate), nextCursor: page.nextCursor };
    },

    async get(id: string): Promise<LibraryItem | null> {
      const doc = await scoped.get('library', id);
      return doc === null ? null : stripPrivate(doc);
    },

    async setPinned(id: string, pinned: boolean): Promise<LibraryItem> {
      return stripPrivate(await scoped.patch('library', id, { pinned }));
    },

    async remove(id: string): Promise<void> {
      const doc = await scoped.get('library', id);
      await scoped.tx(async (tx) => {
        await tx.delete('library', id);
        // The bytes of a published artifact's versions go with it.
        for (const version of doc?.versions ?? []) {
          for (const ref of [version.fileRef, version.previewRef, version.thumbnailRef]) if (ref !== undefined) await tx.delete('artifactFiles', ref);
        }
        // A document's drafts (BACKEND 5.11a) go with it.
        if (doc?.render === 'doc') {
          for (const draft of (await tx.list('documentDrafts', { where: { parentId: id }, limit: 200 })).items) await tx.delete('documentDrafts', draft.id);
        }
      });
    },

    async upload(input: UploadInput, ownerId: string): Promise<UploadResult> {
      const bytes = Buffer.from(input.contentBase64, 'base64');
      if (bytes.toString('base64') !== input.contentBase64) return { status: 'invalid', reason: 'contentBase64 is not canonical base64' };
      if (bytes.length === 0) return { status: 'invalid', reason: 'the file is empty' };
      if (bytes.length > MAX_FILE_BYTES) return { status: 'too_large' };
      const name = input.name.trim();
      if (name.length === 0 || /[\\/\0]/.test(name)) return { status: 'invalid', reason: 'name must be a plain file name' };
      const mimeType = input.mimeType.trim().length === 0 ? 'application/octet-stream' : input.mimeType.trim();
      const now = new Date().toISOString();
      const size = mimeType.startsWith('image/') ? imageSize(bytes) : undefined;
      const stored = await saveBlob(blobs, bytes, mimeType);
      const doc: LibraryDocument = {
        id: 'lib-' + randomUUID(),
        name,
        kind: mimeType.startsWith('image/') ? 'image' : 'file',
        mimeType,
        sizeBytes: bytes.length,
        ...(size ?? {}),
        shared: 'private',
        source: 'upload',
        tags: [],
        createdAt: now,
        updatedAt: now,
        pinned: false,
        blobKey: stored.blobKey,
        sha256: stored.sha256,
      };
      await scoped.put('library', doc);
      return { status: 'ok', attachment: { id: doc.id, name, kind: doc.kind === 'image' ? 'image' : 'file', mimeType, sizeBytes: bytes.length, ...(size ?? {}) } };
    },

    async download(id: string): Promise<LibraryDownloadResult> {
      const doc = await scoped.get('library', id);
      if (doc === null) return { status: 'not_found' };
      // A published artifact keeps its bytes per version: the library download serves the newest file.
      if (doc.version !== undefined && doc.blobKey === undefined) return createArtifactsModule(scoped, blobs).download(id, doc.version, 'file');
      return verifiedDownload(blobs, doc);
    },
  };
}

/** The bytes of a stored file as a download, after the size and sha256 checks every stored file must pass. */
export async function verifiedDownload(blobs: BlobStore, doc: { name: string; mimeType: string; sizeBytes: number; blobKey?: string; sha256?: string }): Promise<LibraryDownloadResult> {
  if (doc.sizeBytes > MAX_FILE_BYTES) return { status: 'unavailable', reason: 'stored bytes do not match their recorded size' };
  const read = await loadBlob(blobs, doc);
  if (!read.ok) return { status: 'unavailable', reason: read.reason };
  return {
    status: 'ok',
    file: fileDownloadSchema.parse({
      name: doc.name,
      mimeType: doc.mimeType,
      contentBase64: read.bytes.toString('base64'),
      sizeBytes: read.bytes.length,
      ...(doc.sha256 === undefined ? {} : { sha256: doc.sha256 }),
    }),
  };
}

// Public metadata never names the stored bytes: unknown keys (blobKey) are stripped by the public schema.
function stripPrivate(doc: LibraryDocument): LibraryItem {
  return libraryItemSchema.parse(doc);
}
