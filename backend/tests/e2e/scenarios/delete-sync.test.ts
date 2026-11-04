import { describe, expect, it } from 'vitest';
import { createAccount, insertDocRow, listenEvents, scriptedChat } from '../harness/client';

/**
 * Deletions reach every client (BACKEND §5.2c, events): deleting an agent puts a tombstone for each goal, idea, feed post and chat it
 * took with it on the owner's event stream, once, and a phone that was offline replays them from its cursor. Another agent's rows
 * are not announced.
 */
/** No tombstone twice: each payload appears once (the agent's own opening chat is announced as well, so the count is not fixed). */
const expectOnce = (list: unknown[]): void => expect(new Set(list.map((row) => JSON.stringify(row))).size).toBe(list.length);

describe('deletions on the event stream', () => {
  it('an agent deletion announces its goals, ideas, feed posts and chat, and a late client replays them', async () => {
    const account = await createAccount('del-sync');
    const events = await listenEvents(account.cookie);
    try {
      const doomed = await account.api('POST', '/v1/agents', { name: 'Doomed' });
      const keeper = await account.api('POST', '/v1/agents', { name: 'Keeper' });
      expect(doomed.status).toBe(201);
      const { conversationId } = await scriptedChat(account, doomed.body.id, [{ text: 'hello back' }], 'hello');
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 30_000);

      const goal = await account.api('POST', '/v1/goals', { agentId: doomed.body.id, kind: 'goal', title: 'Doomed goal' });
      const keptGoal = await account.api('POST', '/v1/goals', { agentId: keeper.body.id, kind: 'goal', title: 'Kept goal' });
      expect([goal.status, keptGoal.status]).toEqual([201, 201]);
      const at = new Date().toISOString();
      await insertDocRow('ideas', account.userId, { id: 'idea-doomed', agentId: doomed.body.id, text: 'An idea', prompt: 'Do it', status: 'open', createdAt: at, updatedAt: at }, { agentId: doomed.body.id, status: 'open' });
      await insertDocRow('feed_posts', account.userId, { id: 'post-doomed', agentId: doomed.body.id, title: 'A post', summary: 'Something', createdAt: at }, { agentId: doomed.body.id });
      await insertDocRow('feed_posts', account.userId, { id: 'post-kept', agentId: keeper.body.id, title: 'Kept post', summary: 'Something', createdAt: at }, { agentId: keeper.body.id });
      const cursor = events.events.at(-1)?.id ?? 0;

      expect((await account.api('DELETE', `/v1/agents/${doomed.body.id}`)).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'agent.deleted' && e.data.agentId === doomed.body.id);

      const tombstones = (list: typeof events.events) => list.filter((e) => String(e.data.type).endsWith('.deleted')).map((e) => e.data);
      const expected = [
        { type: 'goal.deleted', goalId: goal.body.id },
        { type: 'idea.deleted', ideaId: 'idea-doomed' },
        { type: 'feed.deleted', postId: 'post-doomed' },
        { type: 'conversation.deleted', conversationId },
        { type: 'agent.deleted', agentId: doomed.body.id },
      ];
      expect(tombstones(events.events)).toEqual(expect.arrayContaining(expected));
      expectOnce(tombstones(events.events));

      // A client that was offline reconnects with its cursor and gets the same tombstones, nothing about the other agent.
      const late = await listenEvents(account.cookie, undefined, cursor);
      try {
        await late.waitFor((e) => e.data.type === 'agent.deleted' && e.data.agentId === doomed.body.id);
        expect(tombstones(late.events)).toEqual(expect.arrayContaining(expected));
        expectOnce(tombstones(late.events));
        expect(JSON.stringify(tombstones(late.events))).not.toContain(keeper.body.id);
      } finally {
        late.close();
      }

      // What the server lists agrees with what the stream said.
      expect((await account.api('GET', '/v1/goals')).body.items.map((row: { id: string }) => row.id)).toEqual([keptGoal.body.id]);
      expect((await account.api('GET', '/v1/feed')).body.items.map((row: { id: string }) => row.id)).toEqual(['post-kept']);
      expect((await account.api('GET', '/v1/ideas')).body.items).toEqual([]);
    } finally {
      events.close();
    }
  });
});
