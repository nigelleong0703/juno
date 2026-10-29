import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptModel } from '../harness/client';

/**
 * Unread count and last activity are derived on every read from the conversation's items and
 * `lastReadAt` (never a stored counter): an agent reply makes the chat unread and moves
 * `lastItemAt`, mark-read clears it, the user's own message does not count, and every change
 * reaches other tabs as a `conversation.updated` snapshot.
 */
describe('conversation unread count and last activity', () => {
  it('counts agent replies, clears on mark-read, ignores the user own messages', async () => {
    const account = await createAccount('unread');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Unread' });
      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct',
        memberAgentIds: [agent.body.id],
        firstMessage: { text: 'hello' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const isThis = (e: { data: { conversation?: { id: string } } }) => e.data.conversation?.id === conversationId;

      // The first agent reply: unread 1, lastItemAt is the reply time, and the snapshot event says so.
      const reply = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.type === 'agent_message');
      await events.waitFor((e) => e.data.type === 'conversation.updated' && isThis(e) && e.data.conversation.unreadCount === 1 && e.data.conversation.lastItemAt === reply.data.item.at && typeof e.data.conversation.lastMessagePreview === 'string');
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId);
      const afterReply = await account.api('GET', `/v1/conversations/${conversationId}`);
      expect(afterReply.body.unreadCount).toBe(1);
      expect(afterReply.body.lastItemAt).toBe(reply.data.item.at);
      expect(Date.parse(afterReply.body.lastItemAt)).toBeGreaterThan(Date.parse(created.body.createdAt));
      expect(afterReply.body.lastMessage).toMatchObject({ authorKind: 'agent', at: reply.data.item.at });
      expect(afterReply.body.lastMessagePreview).toBe(afterReply.body.lastMessage.text);
      const listed = await account.api('GET', '/v1/conversations');
      expect(listed.body.items.find((c: { id: string }) => c.id === conversationId)).toMatchObject({ unreadCount: 1, lastItemAt: reply.data.item.at });

      // Mark-read clears it (response, list, and the event other tabs get) and keeps the routine read path.
      const read = await account.api('POST', `/v1/conversations/${conversationId}/mark-read`);
      expect(read.status).toBe(200);
      expect(read.body.unreadCount).toBe(0);
      expect(read.body.lastReadAt).toEqual(expect.any(String));
      await events.waitFor((e) => e.data.type === 'conversation.updated' && isThis(e) && e.data.conversation.unreadCount === 0 && e.data.conversation.lastReadAt === read.body.lastReadAt);
      expect((await account.api('GET', `/v1/conversations/${conversationId}`)).body.unreadCount).toBe(0);
      // lastItemAt does not move on read.
      expect((await account.api('GET', `/v1/conversations/${conversationId}`)).body.lastItemAt).toBe(reply.data.item.at);

      // The user's own message plus a second reply: exactly one unread, and lastItemAt moves forward.
      const text = `E2E-UNREAD-${randomUUID().slice(0, 8)}`;
      scriptModel(`${agent.body.id}:${conversationId}`, [{ text: 'filler' }, { text }]);
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'again' }));
      expect(sent.status).toBe(202);
      const second = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.markdown?.includes(text));
      await events.waitFor((e) => e.data.type === 'conversation.updated' && isThis(e) && e.data.conversation.unreadCount === 1 && e.data.conversation.lastItemAt === second.data.item.at);
      const afterSecond = await account.api('GET', `/v1/conversations/${conversationId}`);
      expect(afterSecond.body.unreadCount).toBe(1);
      expect(afterSecond.body.lastItemAt).toBe(second.data.item.at);
      expect(Date.parse(afterSecond.body.lastItemAt)).toBeGreaterThan(Date.parse(reply.data.item.at));

      // Pin/mute responses carry the same derived fields.
      expect((await account.api('PATCH', `/v1/conversations/${conversationId}`, { pinned: true })).body).toMatchObject({ unreadCount: 1, lastItemAt: second.data.item.at });
    } finally {
      events.close();
    }
  });
});
