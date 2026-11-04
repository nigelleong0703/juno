import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptMessages } from '../harness/client';

/**
 * The take-over request lifecycle: the card is the only way the person gets the screen, and only the person's own
 * action on the screen (take over, then hand back) or the card's Skip ends it. A chat message never does.
 */
describe('take-over request lifecycle', () => {
  it('stays pending across a chat message and is handed back only by the explicit release', async () => {
    const account = await createAccount('takeover-request');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Hands' });
      expect(agent.status).toBe(201);
      const ensured = await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id });
      expect(ensured.status).toBeLessThan(300);
      const screenId: string = ensured.body.screens[0].id;

      const typed = `how do I take over? ${randomUUID().slice(0, 4)}`;
      const reply = `TAP-THE-CARD-${randomUUID().slice(0, 8)}`;
      const afterBack = `BACK-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-takeover', 'request_takeover', { reason: 'Enter your phone number on the page, then tap Hand back' })] },
        { text: reply },
        { text: afterBack },
      ], 'book the ticket');
      const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 30_000);
      const requestId: string = created.data.request.id;
      expect(created.data.request.kind).toBe('computer');
      expect(created.data.request.status).toBe('pending');

      // A message from the person wakes the run but does not hand the screen back.
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: typed }))).status).toBe(202);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reply), 45_000);
      const pending = (await account.api('GET', `/v1/requests/${requestId}`)).body;
      expect(pending.status).toBe('pending');
      expect(pending.decision).toBeUndefined();
      expect((await transcriptMessages(sessionKey)).map((m) => m.text).join('\n')).toContain('Never treat their words as approval');

      // Taking the screen alone does not end it either; handing it back does, and the agent hears about it.
      expect((await account.api('POST', `/v1/screens/${screenId}/take-over`)).status).toBe(200);
      expect((await account.api('GET', `/v1/requests/${requestId}`)).body.status).toBe('pending');
      expect((await account.api('POST', `/v1/screens/${screenId}/return-control`)).status).toBe(200);
      const closed = await events.waitFor((e) => e.data.type === 'request.resolved' && e.data.request.id === requestId, 30_000);
      expect(closed.data.request.status).toBe('approved');
      expect(closed.data.request.decision.mode).toBe('manual');
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(afterBack), 45_000);
    } finally {
      events.close();
    }
  });
});
