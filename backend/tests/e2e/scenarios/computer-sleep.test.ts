import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptModel, stackUrls, toolCall, waitForToolActivity } from '../harness/client';

/**
 * Chatting does not wake a paused computer (BACKEND 7.3a): a context build reads the mirror and syncs only a computer that is
 * already running. A tool that needs the computer still resumes it. "Running" is read from computerd's computer view, whose
 * resource sample exists only while the (fake) computer runs.
 */
describe('chat does not wake the computer', () => {
  it('keeps a paused computer paused through three chat messages and resumes it for a file tool', async () => {
    const account = await createAccount('sleep');
    const agent = await account.api('POST', '/v1/agents', { name: 'Sleeper' });
    expect(agent.status).toBe(201);
    const agentId: string = agent.body.id;
    expect((await account.api('POST', '/v1/computers/ensure', { agentId })).status).toBeLessThan(300);

    const computerd = (path: string, method = 'GET') => fetch(stackUrls().computerdUrl + path, { method, headers: { authorization: `Bearer ${stackUrls().computerdToken}`, 'x-owner-id': account.userId, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    const running = async (): Promise<boolean> => ((await (await computerd('/v1/computer')).json()) as { metrics: unknown }).metrics !== null;
    expect(await running()).toBe(true);

    const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
    expect(created.status).toBe(201);
    const conversationId: string = created.body.id;
    const replies = ['sleep-one', 'sleep-two', 'sleep-three'];
    scriptModel(`${agentId}:${conversationId}`, [
      ...replies.map((text) => ({ text })),
      { toolCalls: [toolCall('w1', 'files.write', { path: '/workspace/sleep.md', content: 'awake' })] },
      { text: 'sleep-four' },
    ]);

    expect((await computerd('/v1/computer/pause', 'POST')).status).toBe(200);
    expect(await running()).toBe(false);

    const events = await listenEvents(account.cookie);
    try {
      const send = async (text: string) => {
        const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
        expect(sent.status).toBe(202);
      };
      for (const reply of replies) {
        await send(`say ${reply}`);
        await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.markdown?.includes(reply), 30_000);
        await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.status === 'completed', 30_000);
        // The run built its context, read the mirror and answered; the computer never left its pause.
        expect(await running()).toBe(false);
      }

      await send('now write a file');
      const activity = await waitForToolActivity(`${agentId}:${conversationId}`, (a) => a.results.length >= 1, 40_000);
      expect(activity.results[0]).toMatchObject({ toolName: 'files.write', isError: false });
      expect(await running()).toBe(true);
    } finally {
      events.close();
    }
  }, 120_000);
});
