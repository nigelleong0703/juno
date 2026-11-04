import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, toolActivity } from '../harness/client';

/**
 * BACKEND §3.3 "repeated failing calls": a tool that always fails runs twice; the third identical attempt is refused with a tool error that
 * names the last error; the fifth ends the run blocked (blockCause no_progress, which the task list shows as failed / no_progress; the
 * unit test checks the cause, this one the run's status and reason).
 * `send_message` without text fails the same way every time ("message text required").
 */
describe('the same failing call, again and again', () => {
  it('executes twice, is refused the third and fourth time, and the fifth attempt ends the run as no_progress', async () => {
    const account = await createAccount('repeat-failures');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Looper' });
      expect(agent.status).toBe(201);
      const bad = (id: string) => ({ toolCalls: [toolCall(id, 'send_message', { kind: 'text', purpose: 'answer' })] });
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [bad('c1'), bad('c2'), bad('c3'), bad('c4'), bad('c5'), { text: 'unreachable' }], 'tell me');
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      const runs = (await account.api('GET', `/v1/runs?conversationId=${conversationId}&limit=10`)).body.items as Array<{ id: string; status: string }>;
      expect(runs.map((run) => run.status)).toEqual(['blocked']);
      const run = await account.api('GET', `/v1/runs/${runs[0]?.id ?? ''}`);
      expect(run.body.error).toContain('failed 4 times in a row');

      const activity = await toolActivity(sessionKey);
      const results = activity.results.filter((result) => result.toolName === 'send_message').map((result) => result.text);
      expect(results).toHaveLength(5);
      expect(results.slice(0, 2).every((text) => text.includes('message text required'))).toBe(true);
      expect(results.slice(2).every((text) => text.includes('This exact call already failed twice with: Error: message text required'))).toBe(true);
    } finally {
      events.close();
    }
  });
});
