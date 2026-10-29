import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptTexts } from '../harness/client';

/**
 * A short wake_at is ended early by a task_done: the shell process exits during the sleep, its notify
 * wake steers the sleeping run, and the run continues long before the 90 second deadline.
 */
describe('short wake_at ended by task_done', () => {
  it('continues as soon as the background process finishes, not at the deadline', async () => {
    const account = await createAccount('wake-early');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Builder' });
      expect(agent.status).toBe(201);
      const ensured = await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id });
      expect(ensured.status).toBeLessThan(300);
      const reply = `BUILD-DONE-${Date.now()}`;
      const started = Date.now();
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-build', 'shell.start', { command: 'fake:exit 0 after 3000', notifyOnExit: true })] },
        { toolCalls: [toolCall('call-sleep', 'wake_at', { when: '+90s', reason: 'check the build' })] },
        { text: reply },
      ], 'build, then wait for it');

      const run = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined, 60_000);
      expect(run.data.metadata.juno.run.status).toBe('completed');
      expect(Date.now() - started).toBeLessThan(60_000);
      const answered = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reply), 10_000);
      expect(answered.data.item.runId).toBe(run.data.metadata.juno.run.id);
      // The wake that ended the sleep is the process completion, delivered into this run's transcript.
      const transcript = await transcriptTexts(sessionKey);
      expect(transcript.some((t) => t.includes('[background task finished') && t.includes('kind=shell'))).toBe(true);
    } finally {
      events.close();
    }
  });
});
