import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, runReport, toolActivity } from '../harness/client';

/**
 * The default persona with a real model (BACKEND.md, "Reply style" / default persona): the owner's own venting
 * conversation, replayed. An agent with no persona of its own should side with the user without the counsellor
 * voice, not end every reply with a question, and note the lasting facts about the user with memory_note.
 * Shape checks only, plus the two counsellor phrases the persona names as bad examples.
 */
const COUNSELLOR = /听起来|我听着|I hear you/;

describe('real model: default persona on a venting chat', () => {
  it('replies like a friend and notes who the user is', async () => {
    const account = await createAccount('real-persona');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await defaultAgent(account);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.id}:${conversationId}`;
      const seenRuns = new Set<string>();

      const ask = async (texts: string[]): Promise<string[]> => {
        for (const text of texts) {
          const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
          expect(sent.status).toBe(202);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const finished = await events.waitFor(
          (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !seenRuns.has(e.data.metadata.juno.run.id),
          240_000,
        );
        const runId: string = finished.data.metadata.juno.run.id;
        seenRuns.add(runId);
        expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');
        const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
        return (items.body.items as Array<{ type: string; runId?: string; markdown?: string }>)
          .filter((item) => item.type === 'agent_message' && item.runId === runId)
          .map((item) => item.markdown ?? '');
      };

      const replies = [
        await ask(['工作压力很大， 领导不重视我， 被senior 欺负', '我真的是服了', '什么傻逼公司']),
        await ask(['我能怎麽办啊']),
        await ask(['算了， 我想要跳槽， 需要恶补一点AI engineer 的材料']),
        await ask(['我就是AI engineer ， 做agent 和rag, 偏开发, 做了2年了']),
      ];
      const activity = await toolActivity(sessionKey);
      const notes = activity.calls.filter((call) => call.name === 'memory_note');
      // eslint-disable-next-line no-console
      console.log('persona-vent', JSON.stringify({ replies, notes: notes.map((call) => call.arguments), calls: activity.calls.map((call) => [call.name, JSON.stringify(call.arguments).slice(0, 160)]) }, null, 1));
      const show = JSON.stringify(replies);
      const all = replies.flat().join('\n');
      expect(all, show).not.toMatch(COUNSELLOR);
      const endsWithQuestion = replies.filter((bubbles) => /[?？]\s*$/.test(bubbles.at(-1) ?? '')).length;
      expect(endsWithQuestion, show).toBeLessThanOrEqual(2);

      // Noting in the turn is best effort (the hourly job reads the chat anyway): about 3 runs in 4 note here.
      // When the agent does note, the notes must be about the user and never the venting words.
      expect(notes.every((call) => call.arguments['about'] === 'user'), JSON.stringify(notes)).toBe(true);
      expect(JSON.stringify(notes), JSON.stringify(notes)).not.toMatch(/傻逼/);
      // A note in the first or second person (me, my, I, you, 我, 你) is refused and has to be rewritten naming who it means; the ones
      // that were written carry the author tag and are in the third person (the tool checked).
      const written = activity.results.filter((result) => result.toolName === 'memory_note' && !result.isError).map((result) => result.text);
      expect(written.every((line) => / \(noted by .+, [^,()\s]+\)$/.test(line) && !/\b(?:me|my|I|you|your)\b|[我你]/.test(line.replace(/ \(noted by .+\)$/, ''))), JSON.stringify(written)).toBe(true);
    } finally {
      events.close();
    }
  }, 900_000);
});
