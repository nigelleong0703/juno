import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, listRuns, runReport } from '../harness/client';

/**
 * A burst of short messages with a real model (BACKEND.md, private quiet window): three texts sent a few
 * hundred milliseconds apart start ONE run and get one reply, the way a person reads all of them before
 * answering. Checks shape only, never wording.
 */
describe('real model: a burst of messages gets one reply', () => {
  it('answers three quick messages with a single run', async () => {
    const account = await createAccount('real-burst');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Tavi' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;

      for (const text of ['work has been rough lately', 'my manager ignores me', 'and a senior keeps dumping his work on me']) {
        const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
        expect(sent.status).toBe(202);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const finished = await events.waitFor(
        (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId,
        240_000,
      );
      expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');
      // Give a stray second run the time it would need to show up.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const runs = (await listRuns(account, conversationId)).filter((run) => run.parentRunId === undefined);
      expect(runs.map((run) => run.id), JSON.stringify(runs)).toEqual([finished.data.metadata.juno.run.id]);

      const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
      const replies = (items.body.items as Array<{ type: string; runId?: string; markdown?: string }>).filter((item) => item.type === 'agent_message');
      expect(replies.length, JSON.stringify(replies)).toBeGreaterThan(0);
      expect(new Set(replies.map((item) => item.runId)), JSON.stringify(replies)).toEqual(new Set([finished.data.metadata.juno.run.id]));
      // No streamed preview: the reply arrives whole.
      expect(events.events.filter((e) => e.data.type === 'message.preview' && e.data.conversationId === conversationId)).toEqual([]);
      // eslint-disable-next-line no-console
      console.log('burst reply', replies.map((item) => item.markdown));
    } finally {
      events.close();
    }
  }, 600_000);
});
