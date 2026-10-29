import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, runNow, toolActivity, transcriptTexts } from '../harness/client';

/**
 * The background goal recorder with a real model, on the owner's own interview-coaching chat (2026-10-16): the chat only coaches,
 * and when the recorder runs it writes ONE goal with a plan and the user's own answers as material, without a word in the chat.
 * The next chat then sees the goal in its context. Shape checks only; the goal is logged for reading.
 */
describe('real model: the recorder keeps the interview goal while the chat just coaches', () => {
  it('records one goal with milestones and quotes, adds no chat message, and the next chat sees it', async () => {
    const account = await createAccount('real-goal-recorder');
    const events = await listenEvents(account.cookie);
    try {
      const agentId: string = (await defaultAgent(account)).id;
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
      const conversationId: string = created.body.id;
      const sessionKey = `${agentId}:${conversationId}`;
      const seenRuns = new Set<string>();

      const say = async (text: string): Promise<void> => {
        const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
        expect(sent.status).toBe(202);
        const finished = await events.waitFor(
          (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !seenRuns.has(e.data.metadata.juno.run.id),
          240_000,
        );
        seenRuns.add(finished.data.metadata.juno.run.id);
      };
      const agentMessages = async (): Promise<number> => {
        const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
        return (items.body.items as Array<{ type: string }>).filter((item) => item.type === 'agent_message').length;
      };

      await say('我是 AI engineer，做 agent 和 RAG，偏开发，做了 2 年，想跳槽投 senior。我觉得你可以帮我准备一下我应该怎么准备');
      await say('我在上家公司做了一个可复用的 RAG 服务，解决知识库零散、tech stack 零散的问题，安全部门的 agent 也在用');
      await say('排查的话我主要看切块是不是合理、信息是不是分散在不同块、召回的候选里有没有答案，然后看重排；我们没有 recall@k，都是工程师人工判断');
      await say('现在什么状态呢');

      // The chat digest is triggered by hand here instead of waiting out the quiet window.
      const before = await agentMessages();
      const outcome = await runNow('ChatDigest', conversationId, account.userId, { ownerId: account.userId, agentId, conversationId });

      const list = (await account.api('GET', `/v1/goals?agentId=${agentId}`)).body.items as Array<{ id: string }>;
      const goal = list[0] === undefined ? undefined : (await account.api('GET', `/v1/goals/${list[0].id}`)).body;
      const show = JSON.stringify({ outcome, goal });
      // eslint-disable-next-line no-console
      console.log('goal-recorder', show);
      expect(list, show).toHaveLength(1);
      expect(goal.status, show).toBe('active');
      expect(goal.milestones.length, show).toBeGreaterThanOrEqual(3);
      expect(goal.milestones.some((m: { status: string }) => m.status === 'done' || m.status === 'doing'), show).toBe(true);
      expect(goal.activity.some((a: { kind: string; milestoneId?: string }) => a.kind === 'quote' && a.milestoneId !== undefined), show).toBe(true);
      expect(await agentMessages(), show).toBe(before);
      expect((await toolActivity(sessionKey)).calls.filter((call) => call.name === 'todo_write'), show).toEqual([]);

      // The next chat starts from the goal: its title is in what the model is given.
      await say('我们上次准备到哪了');
      const context = (await transcriptTexts(sessionKey)).join('\n');
      expect(context.includes(goal.title), show).toBe(true);
    } finally {
      events.close();
    }
  }, 1_200_000);
});
