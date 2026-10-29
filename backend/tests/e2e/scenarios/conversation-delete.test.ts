import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, listRuns, scriptedChat, toolCall, transcriptTexts } from '../harness/client';

/**
 * Delete one conversation (UI bug P-08): the conversation, its messages, runs and requests go, the agent stays,
 * another owner gets 404, and a run that is still live is stopped first so nothing is posted into the deleted chat.
 */
describe('conversation deletion', () => {
  it('deletes only the conversation and everything in it, for its owner only', async () => {
    const account = await createAccount('conv-del');
    const stranger = await createAccount('conv-del-other');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Keeper' });
      expect(agent.status).toBe(201);
      const reply = `DONE-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [{ text: reply }], 'hello');
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 30_000);
      expect(await listRuns(account, conversationId)).toHaveLength(1);
      expect((await transcriptTexts(sessionKey)).length).toBeGreaterThan(0);

      expect((await stranger.api('DELETE', `/v1/conversations/${conversationId}`)).status).toBe(404);
      expect((await account.api('GET', `/v1/conversations/${conversationId}`)).status).toBe(200);

      expect((await account.api('DELETE', `/v1/conversations/${conversationId}`)).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'conversation.deleted' && e.data.conversationId === conversationId);
      expect((await account.api('GET', `/v1/conversations/${conversationId}`)).status).toBe(404);
      expect((await account.api('GET', `/v1/conversations/${conversationId}/items`)).status).toBe(404);
      expect(await listRuns(account, conversationId)).toHaveLength(0);
      expect((await account.api('GET', `/v1/requests?conversationId=${conversationId}`)).body.items).toHaveLength(0);
      expect(await transcriptTexts(sessionKey)).toHaveLength(0);
      expect((await account.api('DELETE', `/v1/conversations/${conversationId}`)).status).toBe(404);

      // The agent is untouched and can start a new chat.
      expect((await account.api('GET', `/v1/agents/${agent.body.id}`)).status).toBe(200);
      const again = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(again.status).toBe(201);
    } finally {
      events.close();
    }
  });

  it('stops a live run first and posts nothing into the deleted conversation', async () => {
    const account = await createAccount('conv-del-live');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Sleeper' });
      const never = `NEVER-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-wait', 'wake_at', { when: '+30s' })] },
        { text: never },
      ], 'wait half a minute then say something');
      const step = await events.waitFor((e) => e.data.type === 'STEP_FINISHED' && e.data.metadata.juno.step?.target === 'wake_at', 30_000);
      const runId: string = step.data.metadata.juno.runId;

      expect((await account.api('DELETE', `/v1/conversations/${conversationId}`)).status).toBe(200);
      expect((await account.api('GET', `/v1/runs/${runId}`)).status).toBe(404);
      expect((await account.api('GET', `/v1/conversations/${conversationId}`)).status).toBe(404);
      await new Promise((r) => setTimeout(r, 2_000));
      expect(events.events.some((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item?.markdown).includes(never))).toBe(false);
      expect(await transcriptTexts(sessionKey)).toHaveLength(0);
      expect((await account.api('GET', `/v1/agents/${agent.body.id}`)).status).toBe(200);
    } finally {
      events.close();
    }
  });
});
