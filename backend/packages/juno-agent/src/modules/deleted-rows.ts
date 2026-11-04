import type { Store } from '../contracts/index.js';
import type { AgentEvent } from '@agent-desktop/public-contracts';

/** Rows a client caches: deleting one tells every open device (`goal.deleted`, `idea.deleted`, `feed.deleted`, `item.deleted`). */
export type AnnouncedCollection = 'items' | 'goals' | 'ideas' | 'feedPosts';

/**
 * Delete one cached row and announce it, in one transaction: the event is written first so its owner still resolves from the
 * row, and either both happen or neither. Every deletion of these four kinds goes through here (the goal route, the agent
 * cascade, any future single-message delete), so a client never keeps a row the server removed. A row that is already
 * gone announces nothing, so a repeat is harmless. Returns whether a row was deleted.
 *
 * Deleting a whole conversation does not come here: its `conversation.deleted` covers every item in it.
 */
export async function deleteAnnounced(store: Store, collection: AnnouncedCollection, id: string): Promise<boolean> {
  return store.tx(async (tx) => {
    const event = await announcement(tx, collection, id);
    if (event === null) return false;
    await tx.emit(event);
    await tx.delete(collection, id);
    return true;
  });
}

async function announcement(store: Store, collection: AnnouncedCollection, id: string): Promise<AgentEvent | null> {
  switch (collection) {
    case 'items': {
      const item = await store.get('items', id);
      return item === null ? null : { type: 'item.deleted', conversationId: item.conversationId, itemId: id };
    }
    case 'goals':
      return (await store.get('goals', id)) === null ? null : { type: 'goal.deleted', goalId: id };
    case 'ideas':
      return (await store.get('ideas', id)) === null ? null : { type: 'idea.deleted', ideaId: id };
    case 'feedPosts':
      return (await store.get('feedPosts', id)) === null ? null : { type: 'feed.deleted', postId: id };
  }
}
