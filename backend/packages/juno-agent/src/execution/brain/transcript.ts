import type { BlobStore, Brain, Store, TranscriptEntry, WakeEvent } from '../../contracts/index.js';
import type { Message, UserMessage } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { attachmentBlocks, wakeAttachmentIds } from '../../modules/attachments/index.js';
import type { AttachmentPlacement } from '../../modules/attachments/placement.js';
import { wakeMessage } from './messages.js';
import { assertNoInlineImages } from './transcript-images.js';

export async function readTranscript(store: Store, sessionKey: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  let cursor: string | undefined;
  do {
    // The session key is the indexed `kind` of its rows (db migration 0012), so only this session's rows are read.
    const page = await store.list('transcripts', { where: { kind: sessionKey }, limit: 500, cursor });
    entries.push(...page.items.filter(entry => entry.sessionKey === sessionKey));
    cursor = page.nextCursor;
  } while (cursor);
  return entries.sort((a, b) => a.seq - b.seq);
}

/**
 * Append messages as new transcript rows. Pass `key` (unique per write, e.g. the step id) from inside a
 * journaled effect: rows then get deterministic ids, and a re-run after a crash between this write and the
 * journal entry rewrites the row it already stored (same seq) instead of appending a second one.
 */
export async function appendToTranscript(store: Store, sessionKey: string, messages: Message[], key?: string, known?: TranscriptEntry[]): Promise<TranscriptEntry[]> {
  const entries = known ?? await readTranscript(store, sessionKey);
  let seq = entries.length ? Math.max(...entries.map(entry => entry.seq)) + 1 : 0;
  const written: TranscriptEntry[] = [];
  for (const [index, message] of messages.entries()) {
    assertNoInlineImages(message);
    const id = key === undefined ? `tx_${randomUUID()}` : `tx_${sessionKey}_${key}_${index}`;
    const previous = entries.find(entry => entry.id === id);
    const entry: TranscriptEntry = {
      id, sessionKey, seq: previous?.seq ?? seq++, message: { ...message },
      compactionEpoch: previous?.compactionEpoch ?? 0, at: previous?.at ?? new Date().toISOString(),
    };
    await store.put('transcripts', entry);
    written.push(entry);
  }
  return written;
}

/** Stable transcript id for a wake event, derived from the durable event id and the session. */
const wakeEntryId = (sessionKey: string, eventId: string): string => `tx_wake_${sessionKey}_${eventId}`;

/**
 * Persist the wake events that started a run. Each entry has a deterministic id, so if the DB write
 * succeeds but Restate loses the step result and replays it, the existing rows keep their seq and no
 * duplicate user turn is appended.
 */
export async function appendWakeEvents(store: Store, blobs: BlobStore, sessionKey: string, events: WakeEvent[], place?: AttachmentPlacement, brain?: Pick<Brain, 'withSessionHarness'>, quietExit = false): Promise<void> {
  const entries = await readTranscript(store, sessionKey);
  const existing = new Set(entries.map(entry => entry.id));
  let seq = entries.length ? Math.max(...entries.map(entry => entry.seq)) + 1 : 0;
  for (const event of events) {
    const id = wakeEntryId(sessionKey, event.id);
    if (existing.has(id)) continue;
    // The wake text is read from the version the session is pinned to (BACKEND §11.2), like its context.
    const message = brain?.withSessionHarness === undefined ? wakeMessage(event, { quietExit }) : await brain.withSessionHarness(entries, () => wakeMessage(event, { quietExit }));
    await store.put('transcripts', {
      id, sessionKey, seq: seq++, message: { ...await wakeWithAttachments(store, blobs, event, message, place) },
      compactionEpoch: 0, at: new Date().toISOString(),
    });
  }
}

/** The wake's user turn; attachments the user referenced are read now and persisted with it (images as blob references), so a replay sees the same content (and the files are copied to the user's computer once, here). */
async function wakeWithAttachments(store: Store, blobs: BlobStore, event: WakeEvent, message: UserMessage, place?: AttachmentPlacement): Promise<UserMessage> {
  const ids = wakeAttachmentIds(event.payload);
  if (ids.length === 0 || typeof message.content !== 'string') return message;
  return { ...message, content: [{ type: 'text', text: message.content }, ...await attachmentBlocks(store, blobs, event.ownerId, ids, place)] };
}
