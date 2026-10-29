import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listItems, listRuns, modelCalls, scriptModel, scriptedChat, runNow as runTimerNow, type Account } from '../harness/client';

/**
 * The goal progress of a chat (BACKEND §5.10, in the chat digest of §5.4): the user chats, the chat agent only replies, and once the chat has
 * been quiet the digest writes the goal (milestones, the user's own answers as material) without a word in the chat. A new goal needs the
 * user's own words as evidence; a chat that is only chit-chat (under 40 characters of the owner's words) makes no model call at all, and
 * a second run with nothing new makes no model call either.
 */
const ASK = '帮我准备 Senior AI Engineer 面试';
const ANSWER = '我们用 BM25 加 reranker 做混合召回，再人工抽检 top10';
const MORE = '谢谢你的建议，我今天先到这里，明天想再练一遍系统设计和算法题，你帮我想想怎么安排比较好';

async function runNow(account: Account, agentId: string, conversationId: string): Promise<{ outcome: string }> {
  return runTimerNow('ChatDigest', conversationId, account.userId, { ownerId: account.userId, agentId, conversationId });
}

const until = async <T>(what: string, read: () => Promise<T | undefined>, seconds = 20): Promise<T> => {
  for (let i = 0; i < seconds * 2; i += 1) {
    const found = await read();
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`never happened: ${what}`);
};

const goalsOf = async (account: Account): Promise<Array<{ id: string; title: string }>> => (await account.api('GET', '/v1/goals')).body.items;

describe('chat digest: goal progress', () => {
  it('records a goal after the chat goes quiet without speaking, and rejects what the user never asked for', async () => {
    const alice = await createAccount('recorder-alice');
    const bob = await createAccount('recorder-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Coach' });
    const agentId: string = agent.body.id;
    const { conversationId } = await scriptedChat(alice, agentId, ['r1', 'r2', 'r3', 'r4'].map((text) => ({ text })), ASK);
    // The digest of this conversation is keyed by the conversation id.
    const digestKey = `digest:${conversationId}`;
    const milestones = [{ title: 'Review RAG basics', status: 'done' }, { title: 'Prepare project stories', status: 'doing' }, { title: 'Mock interview', status: 'todo' }];
    scriptModel(digestKey, [{ text: JSON.stringify({ goals: [{
      title: 'Prepare for Senior AI Engineer interview', summary: 'Stories in progress', milestones, note: 'Talked through the RAG project',
      evidence: ASK, quotes: [{ milestone: 'Prepare project stories', text: ANSWER }, { milestone: 'Prepare project stories', text: 'something the user never said' }],
    }] }) }]);
    const replies = async (): Promise<number> => (await listItems(alice, conversationId)).filter((item) => item.type === 'agent_message').length;
    const idle = async (count: number): Promise<true | undefined> => {
      const runs = (await listRuns(alice, conversationId)).filter((run) => run.parentRunId === undefined);
      return runs.length === count && runs.every((run) => run.status === 'completed') ? true : undefined;
    };
    const say = async (text: string, count: number): Promise<void> => {
      expect((await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }))).status).toBe(202);
      await until(`run ${count} completed`, () => idle(count));
    };
    await until('first run completed', () => idle(1));
    await say(ANSWER, 2);

    // 1. Nobody calls the digest: the quiet window after the last message does, and the goal appears with the user's answer as material.
    const goal = await until('the recorded goal', async () => {
      const found = (await goalsOf(alice))[0];
      const body = found === undefined ? undefined : (await alice.api('GET', `/v1/goals/${found.id}`)).body;
      return body?.activity?.some((a: { kind: string }) => a.kind === 'quote') ? body : undefined;
    });
    expect(goal).toMatchObject({ agentId, title: 'Prepare for Senior AI Engineer interview', status: 'active', summary: 'Stories in progress' });
    expect(goal.milestones.map((m: { title: string; status: string }) => [m.title, m.status])).toEqual(milestones.map((m) => [m.title, m.status]));
    const texts: string[] = goal.activity.map((a: { text: string }) => a.text);
    const stories = goal.milestones.find((m: { title: string }) => m.title === 'Prepare project stories');
    const quotes = goal.activity.filter((a: { kind: string }) => a.kind === 'quote');
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ actor: 'user', kind: 'quote', text: ANSWER, milestoneId: stories.id });
    expect(goal.activity.find((a: { text: string }) => a.text === 'Talked through the RAG project')).toMatchObject({ kind: 'note' });
    expect(texts.filter((text) => text.includes('never said'))).toEqual([]);
    expect(texts).toContain('Talked through the RAG project');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await replies()).toBe(2);
    const runs = (await alice.api('GET', '/v1/runs?limit=100')).body.items as Array<{ kind: string; triggerLabel?: string }>;
    expect(runs.filter((run) => run.kind === 'background' && run.triggerLabel === 'Chat digest')).not.toHaveLength(0);

    // 2. A new goal whose "evidence" the user never wrote is dropped; the call still happened and the checkpoint moved on.
    scriptModel(digestKey, [{ text: JSON.stringify({ goals: [{ title: 'Run a marathon', summary: 'Plan', milestones, evidence: 'please help me run a marathon' }] }) }]);
    const before = modelCalls(digestKey);
    await say(MORE, 3);
    await until('the digest call', async () => (modelCalls(digestKey) > before ? true : undefined));
    expect((await runNow(alice, agentId, conversationId)).outcome).toBe('skipped');
    expect((await goalsOf(alice)).map((g) => g.title)).toEqual(['Prepare for Senior AI Engineer interview']);

    // 3. Chit-chat under the 40-character gate makes no model call; running again with nothing new makes none either.
    const afterChat = modelCalls(digestKey);
    await say('哈哈好的', 4);
    await new Promise((r) => setTimeout(r, 4000));
    expect(modelCalls(digestKey)).toBe(afterChat);
    expect((await runNow(alice, agentId, conversationId)).outcome).toBe('skipped');
    expect(modelCalls(digestKey)).toBe(afterChat);
    expect(await goalsOf(alice)).toHaveLength(1);
    expect(await replies()).toBe(4);

    // 4. Another account sees nothing.
    expect(await goalsOf(bob)).toEqual([]);
    expect((await bob.api('GET', `/v1/goals/${goal.id}`)).status).toBe(404);
  });
});
