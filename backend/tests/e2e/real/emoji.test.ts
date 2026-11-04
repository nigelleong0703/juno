import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport } from '../harness/client';

/**
 * Emoji with a real model (system.voice "How a reply reads"): owner 2026-11-02 "emoji should be on" — light casual moments get a fitting
 * emoji (at most one per message, not every reply), work answers and sad news never. Checks presence only, never wording.
 */
const EMOJI = /\p{Extended_Pictographic}/u;

describe('real model: emoji', () => {
  it('uses a fitting emoji in some casual replies, at most one per message, and none in work answers or bad news', async () => {
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

      // Casual banter: at least one reply carries an emoji, none carries more than one.
      const casual = [
        await ask('haha my cat just knocked my coffee off the table again'),
        await ask('finally friday, finished all my work early today'),
        await ask('thanks for chatting, you are fun'),
      ];
      expect(casual.some((reply) => EMOJI.test(reply)), JSON.stringify(casual)).toBe(true);
      const count = (reply: string): number => [...reply.matchAll(/\p{Extended_Pictographic}/gu)].length;
      expect(casual.filter((reply) => count(reply) > 1), JSON.stringify(casual)).toEqual([]);

      // Task moments with a feeling: a hello and something done carry one.
      const hello = await ask('hey');
      const done = await ask('remind me tomorrow at 9 to call mum');
      expect([hello, done].filter((reply) => EMOJI.test(reply)).length, JSON.stringify([hello, done])).toBeGreaterThanOrEqual(1);

      const work = await ask('give me the steps to boil an egg so the yolk is still soft. just from what you know');
      expect(work, work).not.toMatch(EMOJI);

      const sad = await ask('my grandma passed away this morning');
      expect(sad, sad).not.toMatch(EMOJI);
    } finally {
      events.close();
    }
  }, 900_000);
});
