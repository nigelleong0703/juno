import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, listRuns, scriptedChat, transcriptMessages } from '../harness/client';

/**
 * A task that needs the owner's answer: the agent marks the todo blocked with the question and asks it in
 * chat. Waiting on the owner is a normal rest state, so that run completes (it used to end `blocked`), and
 * the owner's answer starts a run that is told about the blocked task and can act on it, instead of every
 * message ending as another blocked run on the same stale todo.
 */
describe('task waiting for the owner', () => {
  it('completes while waiting, and the owner answer is handled by a run that sees the blocked task', async () => {
    const account = await createAccount('task-input');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Prep' });
      expect(agent.status).toBe(201);
      const question = `Q-${randomUUID().slice(0, 8)} which eval metric?`;
      const resumed = `RESUMED-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [{ id: 'call-todo', name: 'todo_write', arguments: { todos: [{ id: 'mock', content: 'Prepare mock interview', status: 'blocked', note: 'needs the owner to pick the eval metric' }] } }] },
        { text: question },
        { toolCalls: [{ id: 'call-todo2', name: 'todo_write', arguments: { todos: [{ id: 'mock', content: 'Prepare mock interview', status: 'done', evidence: 'owner chose recall@k' }] } }] },
        { text: resumed },
      ], 'prep my mock interview');
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(question), 45_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 30_000);

      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'recall@k' }));
      expect(sent.status).toBe(202);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(resumed), 45_000);
      const finishedRuns = () => events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId);
      for (let i = 0; i < 60 && finishedRuns().length < 2; i += 1) await new Promise((r) => setTimeout(r, 500));

      const runs = (await listRuns(account, conversationId)).filter((run) => run.parentRunId === undefined);
      expect(runs.map((run) => run.status)).toEqual(['completed', 'completed']);
      const transcript = await transcriptMessages(sessionKey);
      const hint = transcript.find((m) => m.role === 'user' && m.text.includes('[internal waiting tasks]') && m.text.includes('needs the owner to pick the eval metric'));
      expect(hint?.text).toContain('owner');
    } finally {
      events.close();
    }
  });
});
