import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listItems, listenEvents, listRuns, scriptedChat, transcriptTexts } from '../harness/client';

/**
 * BACKEND §3.3 "empty or refused final reply": when a person is waiting and the model's final turn is empty, the model step is asked once
 * more with a short note; a second empty turn fails the run with a plain reason (clients show it as a failed run with Retry). Nothing is
 * invented in the agent's name.
 */
describe('an empty final turn in a chat someone waits on', () => {
  it('is asked again once and the second answer is the reply', async () => {
    const account = await createAccount('no-reply-retry');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Echo' });
      expect(agent.status).toBe(201);
      const reply = `Friday it is ${randomUUID().slice(0, 6)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [{ text: '' }, { text: reply }], 'when is the launch?');
      const posted = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && e.data.item.type === 'agent_message');
      expect(posted.data.item.markdown).toBe(reply);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      expect((await transcriptTexts(sessionKey)).some((text) => text.includes('Your last turn was empty. Answer the person now.'))).toBe(true);
    } finally {
      events.close();
    }
  });

  it('fails the run with a plain reason when the model is empty twice, and posts nothing', async () => {
    const account = await createAccount('no-reply-fail');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Echo' });
      expect(agent.status).toBe(201);
      const { conversationId } = await scriptedChat(account, agent.body.id, [{ text: '' }, { text: '  ' }], 'when is the launch?');
      await events.waitFor((e) => e.data.type === 'RUN_ERROR' && e.data.metadata.juno.run.conversationId === conversationId);
      const runs = await listRuns(account, conversationId);
      expect(runs.map((run) => run.status)).toEqual(['failed']);
      const run = await account.api('GET', `/v1/runs/${runs[0]?.id ?? ''}`);
      expect(run.body.error).toContain('gave no answer');
      expect((await listItems(account, conversationId)).filter((item) => item.type === 'agent_message')).toEqual([]);
    } finally {
      events.close();
    }
  });
});
