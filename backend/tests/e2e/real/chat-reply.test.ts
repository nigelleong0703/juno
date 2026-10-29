import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport } from '../harness/client';

/**
 * Real-model smoke: a direct chat message reaches the real model through the harness and its reply
 * lands as one agent bubble. Checks behaviour only, never the wording.
 */
describe('real model: chat reply', () => {
  it('answers a direct message with a visible reply and finishes the run', async () => {
    const account = await createAccount('real-chat');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Echo' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct', memberAgentIds: [agent.body.id], firstMessage: { text: 'Reply with one short sentence: what is 2 + 3?' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      // A run that finishes without posting a reply must fail with the run's own account of why (known flake: preview streamed, nothing posted).
      const outcome = await events.waitFor(
        (e) => e.data.conversationId === conversationId && e.data.type === 'item.added' && e.data.item.type === 'agent_message'
          || e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId,
        180_000,
      );
      const previews = events.events.filter((e) => e.data.type === 'TEXT_MESSAGE_CONTENT' && e.data.metadata?.juno?.attemptId !== undefined && e.data.metadata.juno.conversationId === conversationId).length;
      expect(outcome.data.type, outcome.data.type === 'RUN_FINISHED' ? `run finished without a reply (previews seen: ${previews}) ${await runReport(account, outcome.data.metadata.juno.run.id)}` : '').toBe('item.added');
      const reply = outcome;
      expect(String(reply.data.item.markdown)).toMatch(/5|five/i);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === reply.data.item.runId, 60_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
    } finally {
      events.close();
    }
  });
});
