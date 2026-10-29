import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport, toolActivity } from '../harness/client';

/**
 * A background shell command with a real model: the first turn starts a long command with notifyOnExit,
 * the second turn lists the background tasks and stops that process by the id the listing shows. Assertions
 * check tool calls and their results, never wording. The default computer keeps a started process running
 * until it is stopped, so the stop is observable in the final listing.
 */
describe('real model: background shell task', () => {
  it('starts a command in the background with notifyOnExit, then lists it and stops it', async () => {
    const account = await createAccount('real-bg-shell');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Runner' });
      expect(agent.status).toBe(201);
      const ensured = await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id });
      expect(ensured.status).toBeLessThan(300);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;

      const ask = async (text: string, previousRunId?: string): Promise<string> => {
        const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
        expect(sent.status).toBe(202);
        const finished = await events.waitFor(
          (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && e.data.metadata.juno.run.id !== previousRunId,
          200_000,
        );
        expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');
        return finished.data.metadata.juno.run.id;
      };

      const firstRunId = await ask(
        'Start this command in the background with notifyOnExit set to true: sleep 600 . Do not wait for it to finish. ' +
          'Then reply with one short sentence confirming it is running.',
      );
      const secondRunId = await ask(
        'List your background tasks, find the sleep process, and stop it. Then reply with one short sentence confirming it is stopped.',
        firstRunId,
      );
      expect(secondRunId).not.toBe(firstRunId);

      const activity = await toolActivity(sessionKey);
      const start = activity.calls.find((call) => call.name === 'shell.start');
      expect(start, JSON.stringify(activity)).toBeDefined();
      expect(start?.arguments['notifyOnExit'], JSON.stringify(activity)).toBe(true);

      // The id comes from the listing the model read; task_stop must name that same task.
      const listing = activity.results.filter((result) => result.toolName === 'tasks_list');
      const taskId = /- (shell-\S+) · shell · running/.exec(listing.map((result) => result.text).join('\n'))?.[1];
      expect(taskId, JSON.stringify(activity)).toBeDefined();
      const listCallIndex = activity.calls.findIndex((call) => call.name === 'tasks_list');
      const stopCallIndex = activity.calls.findIndex((call) => call.name === 'task_stop');
      expect(listCallIndex, JSON.stringify(activity)).toBeGreaterThanOrEqual(0);
      expect(stopCallIndex, JSON.stringify(activity)).toBeGreaterThan(listCallIndex);
      expect(activity.calls[stopCallIndex]?.arguments['taskId'], JSON.stringify(activity)).toBe(taskId);
      expect(activity.results.find((result) => result.toolName === 'task_stop')?.isError, JSON.stringify(activity)).toBe(false);

      // A listing read after the stop must show the task stopped (a model that stops without re-listing is fine).
      const stopResultIndex = activity.results.findIndex((result) => result.toolName === 'task_stop');
      const afterStop = activity.results.slice(stopResultIndex + 1).filter((result) => result.toolName === 'tasks_list');
      if (afterStop.length > 0) expect(afterStop.at(-1)?.text ?? '', JSON.stringify(activity)).toContain(taskId + ' · shell · stopped');
    } finally {
      events.close();
    }
  }, 480_000);
});
