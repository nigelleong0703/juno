import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents } from '../harness/client';

/**
 * Pin and mute one chat (UI bugs P-06 / P-07): PATCH /v1/conversations/:id stores the flags on the
 * conversation, the list returns them, `conversation.updated` reaches other tabs, mark-read keeps them,
 * and another owner gets 404.
 */
describe('conversation pin and mute', () => {
  it('stores pinned/muted per conversation, emits an update event, and is owner-scoped', async () => {
    const account = await createAccount('conv-flags');
    const stranger = await createAccount('conv-flags-other');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Flagged' });
      const first = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const room = await account.api('POST', '/v1/conversations', { kind: 'room', memberAgentIds: [agent.body.id], title: 'Crew' });
      expect(first.status).toBe(201);
      expect(room.status).toBe(201);
      expect(first.body.pinned ?? false).toBe(false);
      expect(first.body.muted ?? false).toBe(false);

      const pinned = await account.api('PATCH', `/v1/conversations/${first.body.id}`, { pinned: true });
      expect(pinned.status).toBe(200);
      expect(pinned.body).toMatchObject({ id: first.body.id, pinned: true });
      await events.waitFor((e) => e.data.type === 'conversation.updated' && e.data.conversation.id === first.body.id && e.data.conversation.pinned === true);

      const muted = await account.api('PATCH', `/v1/conversations/${first.body.id}`, { muted: true });
      expect(muted.body).toMatchObject({ pinned: true, muted: true });

      // The flags are per conversation: the room is untouched, and mark-read keeps both flags.
      expect((await account.api('GET', `/v1/conversations/${room.body.id}`)).body.muted ?? false).toBe(false);
      expect((await account.api('POST', `/v1/conversations/${first.body.id}/mark-read`)).body).toMatchObject({ pinned: true, muted: true });
      const listed = await account.api('GET', '/v1/conversations');
      expect(listed.body.items.find((c: { id: string }) => c.id === first.body.id)).toMatchObject({ pinned: true, muted: true });

      const cleared = await account.api('PATCH', `/v1/conversations/${first.body.id}`, { pinned: false, muted: false });
      expect(cleared.body).toMatchObject({ pinned: false, muted: false });

      expect((await account.api('PATCH', `/v1/conversations/${first.body.id}`, { pinned: 'yes' })).status).toBe(400);
      expect((await account.api('PATCH', `/v1/conversations/${first.body.id}`, { title: 'renamed' })).status).toBe(400);
      expect((await stranger.api('PATCH', `/v1/conversations/${first.body.id}`, { muted: true })).status).toBe(404);
      expect((await account.api('GET', `/v1/conversations/${first.body.id}`)).body.muted).toBe(false);
      expect((await account.api('PATCH', '/v1/conversations/cvn-missing', { muted: true })).status).toBe(404);
    } finally {
      events.close();
    }
  });
});
