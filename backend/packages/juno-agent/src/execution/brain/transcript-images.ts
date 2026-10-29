/**
 * Images in transcript rows (BACKEND §5.2a): a row keeps `{ type: 'image', mimeType, data: '', blobKey }` and the bytes
 * live in the blob store. Each model request reads them back (`withImages`), so the provider sees exactly the base64
 * it would have seen before and the cached prefix stays byte-identical. Keys are content addresses, so the bytes
 * behind a key never change and a small in-process cache saves re-reading the same screenshot every step.
 */
import type { ImageContent, Message, TextContent } from '@earendil-works/pi-ai';
import { saveBlob, type BlobStore } from '../../contracts/index.js';

type Part = TextContent | ImageContent;

/** The transcript form of an image whose bytes are already in the blob store. */
export const imageRef = (mimeType: string, blobKey: string) => ({ type: 'image' as const, mimeType, data: '' as const, blobKey });

const blobKeyOf = (part: Part): string | undefined => ('blobKey' in part && typeof part.blobKey === 'string' ? part.blobKey : undefined);
const inline = (part: Part): part is ImageContent => part.type === 'image' && part.data !== '';

/** The image-carrying parts of a message (user turns and tool results), or undefined for any other message. */
function partsOf(message: Message): Part[] | undefined {
  if (message.role === 'toolResult') return message.content;
  if (message.role === 'user' && Array.isArray(message.content)) return message.content;
  return undefined;
}

function withParts<M extends Message>(message: M, parts: Part[]): M {
  return { ...message, content: parts };
}

/** Move every inline image of a message (a tool result's screenshot, a fetched picture) into the blob store. */
export async function offloadImages<M extends Message>(blobs: BlobStore, message: M): Promise<M> {
  const parts = partsOf(message);
  if (parts === undefined || !parts.some(inline)) return message;
  return withParts(message, await Promise.all(parts.map(async (part): Promise<Part> => {
    if (!inline(part)) return part;
    const stored = await saveBlob(blobs, Buffer.from(part.data, 'base64'), part.mimeType);
    return imageRef(part.mimeType, stored.blobKey);
  })));
}

/** Transcript rows never carry image bytes: a writer that forgot `offloadImages` fails here instead of filling Postgres. */
export function assertNoInlineImages(message: Message): void {
  if (partsOf(message)?.some(inline)) throw new Error('transcript: image bytes must go to the blob store first (offloadImages)');
}

const CACHE_CHARS = 64 * 1024 * 1024;
const cache = new Map<string, string>();
let cachedChars = 0;

async function base64For(blobs: BlobStore, key: string): Promise<string | null> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const bytes = await blobs.get(key);
  if (bytes === null) return null;
  const data = bytes.toString('base64');
  cache.set(key, data);
  cachedChars += data.length;
  for (const [oldest, value] of cache) {
    if (cachedChars <= CACHE_CHARS) break;
    cache.delete(oldest);
    cachedChars -= value.length;
  }
  return data;
}

/** The messages as the provider needs them: every image reference replaced by its bytes. A lost object becomes a note. */
export async function withImages(blobs: BlobStore, messages: Message[]): Promise<Message[]> {
  return Promise.all(messages.map(async (message) => {
    const parts = partsOf(message);
    if (parts === undefined || !parts.some((part) => blobKeyOf(part) !== undefined)) return message;
    return withParts(message, await Promise.all(parts.map(async (part): Promise<Part> => {
      const key = blobKeyOf(part);
      if (key === undefined || part.type !== 'image') return part;
      const data = await base64For(blobs, key);
      return data === null ? { type: 'text', text: '[image unavailable: its stored copy is missing]' } : { type: 'image', mimeType: part.mimeType, data };
    })));
  }));
}
