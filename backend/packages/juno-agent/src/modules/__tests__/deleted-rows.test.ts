import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../testing/store.js';
import { deleteAnnounced } from '../deleted-rows.js';

const AT = '2026-11-02T00:00:00.000Z';

describe('deleting a cached row', () => {
  it('deletes the row and announces it to its owner exactly once, whatever the kind', async () => {
    const base = createMemoryStore();
    const rows = base.forOwner?.('owner-1');
    if (rows === undefined) throw new Error('the memory store has owner scopes');
    await rows.put('goals', { id: 'g1', agentId: 'a1', kind: 'goal', title: 't', summary: '', status: 'active', createdAt: AT, updatedAt: AT } as never);
    await rows.put('ideas', { id: 'i1', agentId: 'a1', text: 't', prompt: 'p', status: 'open', createdAt: AT, updatedAt: AT } as never);
    await rows.put('feedPosts', { id: 'p1', agentId: 'a1', title: 't', summary: 's', createdAt: AT } as never);
    await rows.put('conversations', { id: 'c1', kind: 'direct', agentIds: ['a1'], createdAt: AT } as never);
    await rows.put('items', { id: 'm1', conversationId: 'c1', type: 'agent_message', markdown: 'hi', at: AT } as never, { conversationId: 'c1' });

    for (const [collection, id] of [['goals', 'g1'], ['ideas', 'i1'], ['feedPosts', 'p1'], ['items', 'm1']] as const) {
      expect(await deleteAnnounced(rows, collection, id)).toBe(true);
      expect(await rows.get(collection, id)).toBeNull();
      expect(await deleteAnnounced(rows, collection, id)).toBe(false);
    }

    const seen = (await base.eventBus.forOwner?.('owner-1').since(0))?.map((stored) => stored.event).filter((event) => event.type.endsWith('.deleted'));
    expect(seen).toEqual([
      { type: 'goal.deleted', goalId: 'g1' },
      { type: 'idea.deleted', ideaId: 'i1' },
      { type: 'feed.deleted', postId: 'p1' },
      { type: 'item.deleted', conversationId: 'c1', itemId: 'm1' },
    ]);
  });
});
