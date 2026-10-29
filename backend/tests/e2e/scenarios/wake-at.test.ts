import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, queryStack, scriptedChat, toolCall } from '../harness/client';

/**
 * H-74: a long wake_at no longer holds the run asleep. The agent acknowledges and the turn ends right
 * away (a timer wake is scheduled for later), and it answers a new message in the same chat meanwhile.
 */
describe('wake_at', () => {
  it('ends the turn for a long wait and stays free for new messages', async () => {
    const account = await createAccount('wake-at');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Reminder' });
      expect(agent.status).toBe(201);
      const ack = `ACK-${randomUUID().slice(0, 8)}`;
      const freeReply = `FREE-${randomUUID().slice(0, 8)}`;
      const started = Date.now();
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-wake', 'wake_at', { when: '+3m', reason: 'check the fares again' })] },
        { text: ack },
        { text: freeReply },
      ], 'remind me in 3 minutes');

      const first = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 30_000);
      expect(first.data.metadata.juno.run.status).toBe('completed');
      // The agent acknowledges the reminder in the same turn instead of ending silently.
      const acknowledged = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(ack), 30_000);
      expect(acknowledged.data.item.runId).toBe(first.data.metadata.juno.run.id);
      // Ended long before the 3 minutes: the run did not sleep through the wait.
      expect(Date.now() - started).toBeLessThan(60_000);

      // The timer wake is durably scheduled for this chat's session, about 3 minutes out.
      const rows = await queryStack("SELECT key, not_before FROM invocations WHERE service = 'Session' AND handler = 'receive' AND status = 'pending' AND not_before IS NOT NULL");
      const mine = rows.filter((r) => r['key'] === `${agent.body.id}:${conversationId}`);
      expect(mine).toHaveLength(1);
      const dueIn = Number(mine[0]?.['not_before']) - Date.now();
      expect(dueIn).toBeGreaterThan(60_000);
      expect(dueIn).toBeLessThan(4 * 60_000);

      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'are you there?' }));
      expect(sent.status).toBe(202);
      const reply = await events.waitFor(
        (e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(freeReply),
        30_000,
      );
      expect(reply.data.item.type).toBe('agent_message');
    } finally {
      events.close();
    }
  });
});
