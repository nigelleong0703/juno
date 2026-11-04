/**
 * How deliveries get their outbox row (BACKEND 5.7.11). The source of truth is what is stored (an item, a question, a finished run), never the live
 * bus: an event only makes the row sooner. The same functions run for the event of a new item, for a catch-up scan at start-up (everything of the last
 * 24 hours) and for a short periodic scan (the last ten minutes), and a row id is made from its source, so offering the same thing twice queues it once.
 * Every stored agent bubble is final text (a reply is posted once, whole), so each one gets its own row: a send_message with several messages
 * reaches the platform as several messages.
 */
import type { Store } from '@agent-desktop/contracts';
import { parseStoredRequest } from '@agent-desktop/contracts';
import { richFromRequest } from '@agent-desktop/channels/render';
import { channelMetaOf } from '../routes/channels.js';
import { holdsQuietReply, originOfItem, originOfRequest } from '../channels/origin.js';
import { ensureOwnerChat, type ChannelSenders } from '../channels/delivery.js';
import { cardRowId, enqueueRow, replyRowId } from './rows.js';

const PAGE = 200;

/** Queue one agent reply for its platform chat. False when it is not owed (an app chat, a quiet group) or already queued. */
export async function ingestItem(store: Store, item: { id: string; type: string; conversationId: string }): Promise<boolean> {
  if (item.type !== 'agent_message') return false;
  const stored = await store.get('items', item.id);
  if (stored === null || stored.type !== 'agent_message') return false;
  const conv = await store.get('conversations', stored.conversationId);
  if (conv === null) return false;
  const ownerId = (conv as { ownerId?: unknown }).ownerId;
  // An app-only conversation has nothing to deliver; a quiet group gets no reply it was not addressed for.
  if (typeof ownerId !== 'string' || (channelMetaOf(conv) === undefined && stored.replyTo === undefined) || holdsQuietReply(conv, stored)) return false;
  const origin = originOfItem(stored, conv);
  if (origin === undefined) return false;
  return enqueueRow(store, {
    id: replyRowId(stored.id), ownerId, conversationId: stored.conversationId, agentId: stored.agentId, ...(stored.runId === undefined ? {} : { runId: stored.runId }),
    kind: 'channel_reply', sourceId: stored.id, destination: { type: 'channel', origin }, platform: origin.kind, at: stored.at,
  }, new Date().toISOString());
}

/**
 * Queue one pending question or approval for its platform chat. An approval someone else's ask raised goes to the owner's private chat (BACKEND 6.8),
 * which may not be known yet: it is opened first, so the row has somewhere to go.
 */
export async function ingestRequest(store: Store, requestId: string, senders: ChannelSenders): Promise<boolean> {
  const stored = await store.get('requests', requestId);
  if (stored === null || stored.status !== 'pending' || stored.conversationId === undefined) return false;
  if (richFromRequest(parseStoredRequest(stored)) === undefined) return false;
  if (stored.payload.kind === 'approval' && stored.payload.askedBy !== undefined) await ensureOwnerChat(store, senders, stored.conversationId);
  const ownerId = (stored as { ownerId?: unknown }).ownerId;
  const asked = await originOfRequest(store, stored);
  if (typeof ownerId !== 'string' || asked === undefined) return false;
  return enqueueRow(store, {
    id: cardRowId(stored.id), ownerId, conversationId: stored.conversationId, agentId: stored.agentId, ...(stored.runId === undefined ? {} : { runId: stored.runId }),
    kind: 'channel_request_card', sourceId: stored.id, destination: { type: 'channel', origin: asked.origin }, platform: asked.origin.kind, at: stored.createdAt,
  }, new Date().toISOString());
}

/** Remembers what a periodic scan has already offered, so ten minutes of items are not looked at every few seconds. Bounded. */
export function createSeen(limit = 20_000): { has(id: string): boolean; add(id: string): void } {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.size >= limit) ids.delete(ids.values().next().value as string);
      ids.add(id);
    },
  };
}

/** Offer every agent reply stored since `sinceMs` (newest first, across owners). Returns how many rows were made. */
export async function scanItems(store: Store, sinceMs: number, seen?: { has(id: string): boolean; add(id: string): void }): Promise<number> {
  let made = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await store.list('items', { orderBy: 'at', order: 'desc', limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      if (Date.parse(item.at) < sinceMs) return made;
      if (item.type !== 'agent_message' || seen?.has(item.id) === true) continue;
      if (await ingestItem(store, item)) made += 1;
      seen?.add(item.id);
    }
    if (page.nextCursor === undefined) return made;
    cursor = page.nextCursor;
  }
}

/** Offer every pending question stored since `sinceMs`. */
export async function scanRequests(store: Store, sinceMs: number, senders: ChannelSenders): Promise<number> {
  let made = 0;
  let cursor: string | undefined;
  do {
    const page = await store.list('requests', { where: { status: 'pending' }, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const request of page.items) {
      if (Date.parse(request.createdAt) >= sinceMs && await ingestRequest(store, request.id, senders)) made += 1;
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return made;
}
