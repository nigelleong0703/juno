import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport } from '../harness/client';

/**
 * Emoji with a real model (context.ts "Emoji like a friend texting"): casual talk carries an emoji now and then even
 * when the user never types one; a work answer and bad news carry none. Owner feedback 2026-10-21: "u looks very cold".
 * Checks presence only, never which emoji or wording.
 */
const EMOJI = /\p{Extended_Pictographic}/u;

describe('real model: emoji', () => {
  it('uses emoji in casual talk without the user using any, and none in work answers or bad news', async () => {
    const account = await createAccount('real-emoji');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Tavi' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const seenRuns = new Set<string>();

      /** Send one message, wait for its run, return the run's reply text. */
      const ask = async (text: string): Promise<string> => {
        const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
        expect(sent.status).toBe(202);
        const finished = await events.waitFor(
          (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !seenRuns.has(e.data.metadata.juno.run.id),
          240_000,
        );
        const runId: string = finished.data.metadata.juno.run.id;
        seenRuns.add(runId);
        expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');
        const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
        const reply = (items.body.items as Array<{ type: string; runId?: string; markdown?: string }>)
          .filter((item) => item.type === 'agent_message' && item.runId === runId)
          .map((item) => item.markdown ?? '')
          .join('\n\n');
        expect(reply, `no reply for: ${text}`).not.toBe('');
        return reply;
      };

      // Casual banter, no emoji from the user: at least one reply should carry one.
      const casual = [
        await ask('haha my cat just knocked my coffee off the table again'),
        await ask('finally friday, finished all my work early today'),
        await ask('thanks for chatting, you are fun'),
      ];
      expect(casual.some((reply) => EMOJI.test(reply)), JSON.stringify(casual)).toBe(true);

      const work = await ask('give me the steps to boil an egg so the yolk is still soft. just from what you know');
      expect(work, work).not.toMatch(EMOJI);

      const sad = await ask('my grandma passed away this morning');
      expect(sad, sad).not.toMatch(EMOJI);
    } finally {
      events.close();
    }
  }, 900_000);
});
