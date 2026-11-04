/**
 * The `delivery` field of an agent bubble (contracts changed, BACKEND 5.7.11): read from the outbox row of that bubble each time the conversation is
 * read, never stored on the item. A bubble with no row (it stays in the app, or its row is not made yet) has none.
 */
import type { Store } from '@agent-desktop/contracts';
import type { DeliveryState, Item } from '@agent-desktop/public-contracts';
import type { OutboxRow } from 'juno-agent/contracts';
import { replyRowId } from './rows.js';

export const deliveryOf = (row: Pick<OutboxRow, 'status' | 'droppedReason'>): DeliveryState => ({ status: row.status, ...(row.droppedReason === undefined ? {} : { reason: row.droppedReason }) });

/** The items with `delivery` on every agent reply that has an outbox row. */
export async function withDelivery(store: Store, items: Item[]): Promise<Item[]> {
  const ids = items.filter((item) => item.type === 'agent_message').map((item) => replyRowId(item.id));
  if (ids.length === 0) return items;
  const rows = new Map((await store.list('outbox', { where: { ids }, limit: ids.length })).items.map((row) => [row.id, row]));
  return items.map((item) => {
    const row = item.type === 'agent_message' ? rows.get(replyRowId(item.id)) : undefined;
    return item.type === 'agent_message' && row !== undefined ? { ...item, delivery: deliveryOf(row) } : item;
  });
}

/** Tell the open clients that a reply's delivery state changed (it was given up on, or put back by the owner), as the item again with `delivery`. */
export async function announceDelivery(store: Store, row: OutboxRow): Promise<void> {
  if (row.kind !== 'channel_reply' || row.ownerId === undefined || row.conversationId === undefined || typeof store.forOwner !== 'function') return;
  const scoped = store.forOwner(row.ownerId);
  const item = await scoped.get('items', row.sourceId);
  if (item?.type !== 'agent_message') return;
  await scoped.emit({ type: 'item.added', conversationId: row.conversationId, item: { ...item, delivery: deliveryOf(row) } });
}
