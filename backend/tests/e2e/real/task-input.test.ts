import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, listRuns } from '../harness/client';

/**
 * Real-model: work that needs the owner's answer. The agent asks in chat and parks the task; the owner
 * answers in the same chat; the answer is handled by a run that finishes normally. No top-level run may
 * end `blocked` because a task is waiting on input. Behaviour only, never the wording.
 */
describe('real model: task waiting for the owner', () => {
  it('asks, then continues from the chat answer without piling up blocked runs', async () => {
    const account = await createAccount('real-task-input');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Prep' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct', memberAgentIds: [agent.body.id], firstMessage: { text:
          'Use todo_write to plan one goal: "Pick the evaluation metric for my RAG interview prep". You cannot do it until I tell you which metric I prefer, so mark that todo blocked with a note, and ask me which metric in your reply. Do nothing else.' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const settled = (n: number) => events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined).length >= n;
      const waitRuns = async (n: number) => { for (let i = 0; i < 360 && !settled(n); i += 1) await new Promise((r) => setTimeout(r, 500)); expect(settled(n)).toBe(true); };
      await waitRuns(1);

      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'I prefer recall@k. Please go ahead and mark the goal done.' }));
      expect(sent.status).toBe(202);
      await waitRuns(2);

      const runs = (await listRuns(account, conversationId)).filter((run) => run.parentRunId === undefined);
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs.map((run) => run.status)).not.toContain('blocked');
    } finally {
      events.close();
    }
  });
});
