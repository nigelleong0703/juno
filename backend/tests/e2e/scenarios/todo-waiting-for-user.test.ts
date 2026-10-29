import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import type { Account } from '../harness/client';
import { createAccount, listenEvents, listRuns, scriptedChat, scriptModel, transcriptTexts } from '../harness/client';

/**
 * A task blocked on the user's answer is a normal end of the run: the reply that asks the question completes
 * the run (no "keep working" hint, no "run blocked" error), the agent goes idle, the task stays blocked in the
 * plan, and the user's next message continues it.
 */
/** The chat's task plan as [id, status] pairs, read from the conversation items. */
async function planStatuses(account: Account, conversationId: string): Promise<string[][]> {
  const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items;
  const plan = items.find((item: { type: string }) => item.type === 'plan');
  return plan.todos.map((t: { id: string; status: string }) => [t.id, t.status]);
}

describe('todo waiting for the user', () => {
  it('completes the run that asks the question and lets the next message finish the task', async () => {
    const account = await createAccount('todo-waiting');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Coach' });
      const agentId: string = agent.body.id;
      const todo = { id: 'plan', content: 'Pick a training plan', status: 'blocked', note: 'waiting for the user to say how many days a week they can train' };
      const turns = [
        { toolCalls: [{ id: 'call-plan', name: 'todo_write', arguments: { todos: [todo] } }] },
        { text: 'How many days a week can you train?' },
        { toolCalls: [{ id: 'call-done', name: 'todo_write', arguments: { todos: [{ id: 'plan', content: 'Pick a training plan', status: 'done' }] } }] },
        { text: 'Three days it is. Plan set.' },
      ];
      const { conversationId, sessionKey } = await scriptedChat(account, agentId, turns, 'help me start training');

      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 45_000);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      expect(finished.data.metadata.juno.run.error).toBeUndefined();
      await events.waitFor((e) => e.data.type === 'agent.status' && e.data.agentId === agentId && e.data.status === 'idle' && e.id > finished.id, 30_000);
      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.status).toBe('idle');

      expect(await planStatuses(account, conversationId)).toEqual([['plan', 'blocked']]);
      expect((await transcriptTexts(sessionKey)).join('\n')).not.toContain('internal task check');

      scriptModel(sessionKey, turns);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'three days' }))).status).toBe(202);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.id > finished.id, 45_000);

      const runs = await listRuns(account, conversationId);
      expect(runs.map((run) => run.status)).toEqual(['completed', 'completed']);
      expect(await planStatuses(account, conversationId)).toEqual([['plan', 'done']]);
      expect((await transcriptTexts(sessionKey)).join('\n')).not.toContain('internal task check');
      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.status).toBe('idle');
    } finally {
      events.close();
    }
  });
});
