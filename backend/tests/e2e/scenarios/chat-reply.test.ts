import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SCRIPTED_DEFAULT_REPLY, createAccount, listenEvents, scriptModel } from '../harness/client';

describe('chat reply', () => {
  it('delivers the scripted agent reply over SSE and finishes the run', async () => {
    const account = await createAccount('chat');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Echo' });
      expect(agent.status).toBe(201);

      // The conversation id is only known after creation, so the first turn (created with the
      // firstMessage) answers with the scripted model's built-in default for an unscripted session.
      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct',
        memberAgentIds: [agent.body.id],
        firstMessage: { text: 'hello' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;

      const first = await events.waitFor(
        (e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.type === 'agent_message',
      );
      expect(first.data.item.markdown).toContain(SCRIPTED_DEFAULT_REPLY);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId);

      // Now the session key is known: script the next reply, send a second message, assert it lands.
      // The turn index equals the assistant turns already recorded, hence the filler turn.
      const reply = `E2E-REPLY-${randomUUID().slice(0, 8)}`;
      scriptModel(`${agent.body.id}:${conversationId}`, [{ text: 'filler' }, { text: reply }]);
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'say the magic word' }));
      expect(sent.status).toBe(202);

      const scripted = await events.waitFor(
        (e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.markdown?.includes(reply),
      );
      expect(scripted.data.item.type).toBe('agent_message');
      expect(scripted.data.item.agentId).toBe(agent.body.id);

      const finished = await events.waitFor(
        (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.id === scripted.data.item.runId,
      );
      expect(finished.data.metadata.juno.run.status).toBe('completed');

      // The transcript is durable and ordered: user, reply, user, scripted reply.
      const items = await account.api('GET', `/v1/conversations/${conversationId}/items`);
      expect(items.status).toBe(200);
      const types = items.body.items.map((i: { type: string }) => i.type).filter((t: string) => t === 'user_message' || t === 'agent_message');
      expect(types).toEqual(['user_message', 'agent_message', 'user_message', 'agent_message']);
    } finally {
      events.close();
    }
  });
});
