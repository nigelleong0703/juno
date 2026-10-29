import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptTexts } from '../harness/client';

/**
 * H-72: shell.start with notifyOnExit lets the turn finish; the durable TaskWatcher sees the process exit
 * and wakes the chat once with a task_done (taskKind shell, exit code), and the agent reacts.
 * The fake computer treats `fake:exit <code> after <ms>` as a process that exits after that time.
 */
describe('shell notifyOnExit', () => {
  it('finishes the turn, then is woken once when the process exits', async () => {
    const account = await createAccount('shell-notify');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Builder' });
      expect(agent.status).toBe(201);
      // Bind this account's (fake) computer and the agent's own screen; a fresh account has neither.
      const ensured = await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id });
      expect(ensured.status).toBeLessThan(300);
      const reacted = `BUILD-SEEN-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-start', 'shell.start', { command: 'fake:exit 0 after 3000', notifyOnExit: true })] },
        { text: 'Build started; I will tell you when it finishes.' },
        { text: reacted },
      ], 'run the build');
      const firstRun = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 30_000);
      expect(firstRun.data.metadata.juno.run.status).toBe('completed');
      const startStep = JSON.stringify(firstRun.data.metadata.juno.run.steps ?? []);
      expect(startStep).toContain('woken with a task_done');

      const reply = await events.waitFor(
        (e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reacted),
        45_000,
      );
      expect(reply.data.item.type).toBe('agent_message');
      const transcript = await transcriptTexts(sessionKey);
      const completions = transcript.filter((t) => t.includes('[background task finished') && t.includes('kind=shell'));
      expect(completions).toHaveLength(1);
      expect(completions[0]).toContain('status=completed');
      expect(completions[0]).toContain('exit code 0');
    } finally {
      events.close();
    }
  });
});
