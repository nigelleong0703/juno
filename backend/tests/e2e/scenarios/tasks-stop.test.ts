import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, scriptModel, toolActivity, toolCall, waitForToolActivity } from '../harness/client';

/**
 * tasks_list shows a running shell process with its id; task_stop stops it by that id; a later tasks_list
 * shows the same task as stopped. The id comes from the listing itself, so the script can name it.
 */
describe('tasks_list and task_stop', () => {
  it('lists a running shell process, stops it by id, and lists it as stopped', async () => {
    const account = await createAccount('tasks-stop');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Runner' });
      expect(agent.status).toBe(201);
      const ensured = await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id });
      expect(ensured.status).toBeLessThan(300);
      const firstTurns = [
        { toolCalls: [toolCall('call-start', 'shell.start', { command: 'fake:exit 0 after 600000' })] },
        { toolCalls: [toolCall('call-list', 'tasks_list')] },
        { text: 'dev server is up' },
      ];
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, firstTurns, 'start the dev server');
      const firstRunId: string = (await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 30_000)).data.metadata.juno.run.id;
      const listed = await waitForToolActivity(sessionKey, (a) => a.results.some((r) => r.toolName === 'tasks_list'));
      const running = listed.results.find((r) => r.toolName === 'tasks_list')?.text ?? '';
      const taskId = /- (shell-\S+) · shell · running/.exec(running)?.[1];
      expect(taskId).toBeDefined();

      scriptModel(sessionKey, [
        ...firstTurns,
        { toolCalls: [toolCall('call-stop', 'task_stop', { taskId })] },
        { toolCalls: [toolCall('call-list-2', 'tasks_list')] },
        { text: 'dev server stopped' },
      ]);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'stop the dev server' }))).status).toBe(202);
      const second = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.id !== firstRunId, 30_000);
      expect(second.data.metadata.juno.run.status).toBe('completed');

      const activity = await toolActivity(sessionKey);
      const stop = activity.results.find((r) => r.toolName === 'task_stop');
      expect(stop?.isError).toBe(false);
      expect(stop?.text).toContain('is stopped');
      const lists = activity.results.filter((r) => r.toolName === 'tasks_list');
      expect(lists.at(-1)?.text).toContain(taskId + ' · shell · stopped');
    } finally {
      events.close();
    }
  });
});
