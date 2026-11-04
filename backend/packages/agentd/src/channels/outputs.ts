/**
 * What a run made reaches the place it reports to (BACKEND 6.8). When a run that answered in a platform group finishes, the documents,
 * files and pages it published (`artifact_publish`, a document, from the run's own library rows, never guessed) are posted into the thread
 * the answer went to, as files the platform takes. The model's text stays its own: this is delivery, not a veto, and not a rewrite of
 * what it said. The library copy is untouched.
 *
 * Two halves (BACKEND 5.7.11): `planRunOutputs` decides what is owed and makes one outbox row per document version (so a repeat, a second run
 * event or a restart queues nothing twice); `sendOutputRow` is one attempt to post one row's file, which the outbox sender retries.
 */
import { channelRowId } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import type { BlobStore, Store } from '@agent-desktop/contracts';
import { chatCapabilities, type ChannelOrigin } from '@agent-desktop/public-contracts';
import { channelGrants } from 'juno-agent/modules/channel-origin';
import type { OutboxRow } from 'juno-agent/contracts';
import { chatAccess } from './port.js';
import { conversationOrigin } from './origin.js';
import { unavailableMessage, type ChannelRegistry } from './registry.js';
import type { ChannelDeliveryOutcome } from './delivery.js';
import { enqueueRow, outputRowId } from '../outbox/rows.js';

const log = createLogger({ service: 'agentd' });
const MAX_FILES = 5;

export interface OutputDeps {
  store: Store;
  blobs: BlobStore;
  channels: ChannelRegistry;
  channelFetch?: typeof fetch;
}

/** The run's own documents: library rows made in its conversation by it, or by a child task one level below it. */
async function documentsOfRun(store: Store, conversationId: string, runId: string): Promise<Array<{ id: string; name: string; mimeType: string; version: number; fileRef: string }>> {
  const page = await store.list('library', { where: { conversationId }, limit: 200 });
  const found: Array<{ id: string; name: string; mimeType: string; version: number; fileRef: string }> = [];
  for (const doc of page.items) {
    if (doc.runId === undefined || doc.versions === undefined || doc.versions.length === 0) continue;
    // The run's own, a child's, or the child of an earlier run of this thread's work that finished after that run did (a background task the
    // run that wraps it up reports on): the chain started in this thread. One outbox row keeps each version to one post.
    const row = doc.runId === runId ? undefined : await store.get('runs', doc.runId).catch(() => null);
    const root = row === null || row === undefined ? undefined : row.rootOrigin ?? row.origin;
    const made = doc.runId === runId || row?.parentRunId === runId || (root?.type === 'channel' && root.conversationId === conversationId);
    const latest = doc.versions[doc.versions.length - 1];
    if (made && latest?.fileRef !== undefined) found.push({ id: doc.id, name: doc.name, mimeType: latest.mimeType ?? doc.mimeType ?? 'application/octet-stream', version: latest.version, fileRef: latest.fileRef });
  }
  return found;
}

/** The group thread the run's answer went to: the origin on its newest agent message, only for a group. */
async function originOfAnswer(store: Store, conversationId: string, runId: string): Promise<ChannelOrigin | undefined> {
  const items = await store.list('items', { where: { conversationId }, orderBy: 'at', order: 'desc', limit: 50 });
  // The run's own answer; failing that (the answer came from the run that reported on its work, or went out through send_message) the newest
  // answer in this thread: the conversation is the thread the work was asked in.
  const inGroup = items.items.filter((item) => item.type === 'agent_message' && item.replyTo?.chatType === 'group');
  const answer = inGroup.find((item) => item.type === 'agent_message' && item.runId === runId) ?? inGroup[0];
  if (answer?.type === 'agent_message') return answer.replyTo;
  // No answer item at all (the words went out through send_message): the thread the conversation is bound to.
  const conv = await store.get('conversations', conversationId);
  const bound = conv === null ? undefined : conversationOrigin(conv);
  return bound?.chatType === 'group' ? bound : undefined;
}

/** Queue the documents a finished run made, one outbox row per document version, behind the run's answer. Returns how many rows were made. Never throws. */
export async function planRunOutputs(deps: Pick<OutputDeps, 'store'>, ownerId: string, run: { id: string; agentId: string; conversationId: string }): Promise<number> {
  try {
    // The lists are the owner's: the delivery subscription is not inside a request, so the store is scoped to the owner here.
    const store = deps.store.forOwner?.(ownerId) ?? deps.store;
    const origin = await originOfAnswer(store, run.conversationId, run.id);
    const documents = await documentsOfRun(store, run.conversationId, run.id);
    if (documents.length > 0 || origin !== undefined) log.info({ runId: run.id, answeredInGroup: origin !== undefined, documents: documents.length }, 'run outputs');
    if (origin === undefined || documents.length === 0) return 0;
    if ((await store.get('channels', channelRowId(origin.kind, origin.channelId))) === null) return 0;
    if (!chatCapabilities(origin.kind, await channelGrants(store, origin)).files.send) return 0;
    let queued = 0;
    const now = new Date().toISOString();
    for (const doc of documents.slice(0, MAX_FILES)) {
      const made = await enqueueRow(deps.store, {
        id: outputRowId(doc.id, doc.version), ownerId, conversationId: run.conversationId, agentId: run.agentId, runId: run.id, kind: 'channel_output', sourceId: doc.id + ':' + String(doc.version),
        destination: { type: 'output', origin, docId: doc.id, version: doc.version, fileRef: doc.fileRef, name: doc.name, mimeType: doc.mimeType }, platform: origin.kind, at: now,
      }, now);
      if (made) queued += 1;
    }
    return queued;
  } catch (err) {
    log.warn({ err, runId: run.id }, 'queueing what the run made failed');
    return 0;
  }
}

/** One attempt to post one document row into its thread. */
export async function sendOutputRow(deps: OutputDeps, row: OutboxRow): Promise<ChannelDeliveryOutcome> {
  const destination = row.destination;
  if (destination.type !== 'output' || row.ownerId === undefined) return { status: 'skipped' };
  const origin = destination.origin;
  if (deps.channels.get(origin.kind) === undefined) return { status: 'failed', error: unavailableMessage(origin.kind), failure: { kind: 'platform_unavailable' } };
  const store = deps.store.forOwner?.(row.ownerId) ?? deps.store;
  const chat = await chatAccess(store, deps.channels, row.ownerId, origin);
  if (chat === undefined) {
    const gone = (await store.get('channels', channelRowId(origin.kind, origin.channelId))) === null;
    return { status: 'failed', error: gone ? 'Channel not found' : 'Channel credential could not be opened', failure: { kind: gone ? 'channel_gone' : 'token_invalid' } };
  }
  const file = await store.get('artifactFiles', destination.fileRef);
  const bytes = file === null ? null : await deps.blobs.get(file.blobKey);
  if (file === null || bytes === null) return { status: 'skipped' };
  const sent = await chat.abilities.sendFile(deps.channelFetch ?? fetch, chat.auth, { chatId: origin.chatId, threadId: origin.threadId ?? origin.chatId }, { name: file.name, mime: file.mimeType, bytes }, destination.name);
  if (sent.status === 'ok') return sent.value.messageId === undefined ? { status: 'sent' } : { status: 'sent', externalId: sent.value.messageId };
  // The platform cannot take this file (or refused it by its rules): retrying cannot change that. An upload error without a reading is tried again.
  if (sent.status === 'unsupported' || sent.status === 'skipped') return { status: 'failed', error: sent.status === 'skipped' ? sent.reason : 'The platform does not take files here', failure: { kind: 'content_rejected' } };
  return { status: 'failed', error: sent.error, failure: { kind: 'transient' } };
}
