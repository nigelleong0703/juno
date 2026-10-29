/**
 * Files a platform message carries, into the owner's library: the path an app upload takes (a library row with source `upload`, the
 * bytes in the blob store, never Postgres), so the agent reads them with the same tools. The bytes come through the platform's own
 * `attachment` ability when the message is admitted. A file that cannot be fetched is skipped with a log line; the message still wakes
 * the agent, it just does not have that file.
 */
import { randomUUID } from 'node:crypto';
import { saveBlob, type BlobStore, type ChannelRow, type LibraryDocument, type Store } from '@agent-desktop/contracts';
import type { ChannelFile } from '@agent-desktop/channels/types';
import { imageSize, MAX_MESSAGE_ATTACHMENTS, type Attachment } from '@agent-desktop/public-contracts';
import { createLogger } from '@agent-desktop/log';
import type { ChannelRegistry } from './registry.js';
import { openChannelRow } from './credentials.js';

const log = createLogger({ service: 'agentd' });

export interface InboundFiles {
  /** The message's attachments, as the item carries them (library ids). */
  attachments: Attachment[];
  /** The same library ids, as the wake's `attachmentIds` payload. */
  ids: string[];
}

const NONE: InboundFiles = { attachments: [], ids: [] };

/**
 * Fetch and store the files of one admitted platform message (at most MAX_MESSAGE_ATTACHMENTS of them). Without a blob store (a
 * test without one) or without the platform's ability, nothing is stored and the message is admitted as text.
 */
export async function storeInboundFiles(
  deps: { store: Store; channels: ChannelRegistry; channelFetch?: typeof fetch; blobs?: BlobStore },
  ownerId: string,
  channel: ChannelRow,
  files: readonly ChannelFile[],
  messageId: string,
): Promise<InboundFiles> {
  const blobs = deps.blobs;
  const adapter = deps.channels.get(channel.kind)?.adapter;
  if (blobs === undefined || adapter === undefined || files.length === 0) return NONE;
  const opened = await openChannelRow(deps.store, channel);
  if ('error' in opened) return NONE;
  const { abilities } = adapter;
  const auth = adapter.identity.authOf(opened.channel);
  const scoped = deps.store.forOwner?.(ownerId) ?? deps.store;
  const result: InboundFiles = { attachments: [], ids: [] };
  for (const file of files.slice(0, MAX_MESSAGE_ATTACHMENTS)) {
    const fetched = await abilities.attachment(deps.channelFetch ?? fetch, auth, { messageId, fileId: file.fileId });
    if (fetched.status !== 'ok') {
      log.warn({ channel: channel.kind, status: fetched.status, error: fetched.status === 'failed' ? fetched.error : undefined }, 'platform file was not fetched');
      continue;
    }
    const bytes = fetched.value.bytes;
    const mimeType = file.mimeType ?? fetched.value.mime ?? 'application/octet-stream';
    const kind = mimeType.startsWith('image/') ? 'image' : 'file';
    const size = kind === 'image' ? imageSize(bytes) : undefined;
    const stored = await saveBlob(blobs, bytes, mimeType);
    const now = new Date().toISOString();
    const id = 'lib-' + randomUUID();
    const doc: LibraryDocument = {
      id,
      name: file.name,
      kind,
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
    result.attachments.push({ id, name: file.name, kind, mimeType, sizeBytes: bytes.length, ...(size ?? {}) });
    result.ids.push(id);
  }
  return result;
}
