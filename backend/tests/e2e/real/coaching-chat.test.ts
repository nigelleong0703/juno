import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, runReport, toolActivity } from '../harness/client';

/**
 * Interview coaching with a real model, replaying the owner's own chat (2026-10-16): a conversation whose progress
 * depends on the user's answers is not a task. The agent must not open a todo plan, every run ends completed (not
 * "blocked: tasks need input"), and each reply answers the user's message. Shape checks only.
 */
describe('real model: coaching is a conversation, not a task list', () => {
  it('coaches without a plan and finishes every run', async () => {
    const account = await createAccount('real-coaching');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await defaultAgent(account);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.id] });
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.id}:${conversationId}`;
      const seenRuns = new Set<string>();
      const statuses: string[] = [];
      const replies: string[][] = [];

      const say = async (text: string): Promise<void> => {
        const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
        expect(sent.status).toBe(202);
        const finished = await events.waitFor(
          (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !seenRuns.has(e.data.metadata.juno.run.id),
          240_000,
        );
        const runId: string = finished.data.metadata.juno.run.id;
        seenRuns.add(runId);
        statuses.push(`${finished.data.metadata.juno.run.status}${finished.data.metadata.juno.run.status === 'completed' ? '' : ' ' + (await runReport(account, runId))}`);
        const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
        replies.push((items.body.items as Array<{ type: string; runId?: string; markdown?: string }>)
          .filter((item) => item.type === 'agent_message' && item.runId === runId).map((item) => item.markdown ?? ''));
      };

      await say('我是 AI engineer，做 agent 和 RAG，偏开发，做了 2 年，想跳槽投 senior。我觉得你可以帮我准备一下我应该怎么准备');
      await say('我在上家公司做了一个可复用的 RAG 服务，解决知识库零散、tech stack 零散的问题，安全部门的 agent 也在用');
      await say('排查的话我主要看切块是不是合理、信息是不是分散在不同块、召回的候选里有没有答案，然后看重排；我们没有 recall@k，都是工程师人工判断');
      await say('现在什么状态呢');

      const activity = await toolActivity(sessionKey);
      const show = JSON.stringify({ statuses, replies, tools: activity.calls.map((call) => call.name) });
      // eslint-disable-next-line no-console
      console.log('coaching', show);
      expect(activity.calls.filter((call) => call.name === 'todo_write'), show).toEqual([]);
      expect(statuses.every((status) => status === 'completed'), show).toBe(true);
      expect(replies.every((bubbles) => bubbles.length > 0), show).toBe(true);
      const agentNow = await account.api('GET', `/v1/agents/${agent.id}`);
      expect(agentNow.body.status, show).toBe('idle');
    } finally {
      events.close();
    }
  }, 1_200_000);
});
