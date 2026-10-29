import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptTexts } from '../harness/client';

/**
 * Two read-only calls in one model response run together through the real runner journal (one
 * RestatePromise.all, raced against the stop once) and are answered in call order; the run continues.
 */
describe('parallel read-only tool calls', () => {
  it('runs both calls of one response and continues to the reply', async () => {
    const account = await createAccount('parallel-tools');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Reader' });
      expect(agent.status).toBe(201);
      const reply = `BOTH-READ-${Date.now()}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [
          toolCall('call-mem', 'memory_search', { query: 'travel' }),
          toolCall('call-tasks', 'tasks_list'),
        ] },
        { text: reply },
      ], 'read your memory and your task list');

      const run = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined, 60_000);
      expect(run.data.metadata.juno.run.status).toBe('completed');
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reply), 10_000);
      const transcript = await transcriptTexts(sessionKey);
      expect(transcript.filter((t) => t.length > 0).length).toBeGreaterThan(0);
    } finally {
      events.close();
    }
  });
});
