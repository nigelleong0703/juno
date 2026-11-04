import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, runReport, stackUrls, toolActivity } from '../harness/client';

/**
 * Real model, owner evidence of 2026-11-02 (conversation cvn-4ebd3003…): a paused computer was reported as "unavailable", a Chinese
 * chat got an English opening line, a bare chip row was the whole reply, and a plain "go find it" was answered with "shall I?".
 * The computer is the fake provider: it pauses and resumes like the platform's (passive reads refuse, the first real call resumes).
 */
type Item = { type: string; markdown?: string; runId?: string; ui?: { blocks?: Array<{ type: string }> }; kind?: string; agentId?: string; requestId?: string };

async function items(account: Awaited<ReturnType<typeof createAccount>>, conversationId: string): Promise<Item[]> {
  return (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items as Item[];
}

const CJK = /[一-鿿]/;
const ASKS_PERMISSION = /要我(现在)?[^。？?]{0,20}(吗|么)[？?]?\s*$|shall i|do you want me to|would you like me to/i;

describe('real model: initiative, language, no empty replies, paused computer', () => {
  it('opens a page on a paused computer in the first call, in the person\'s language, with one screen card and no talk of pausing', async () => {
    const account = await createAccount('real-paused');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await defaultAgent(account);
      expect((await account.api('POST', '/v1/computers/ensure', { agentId: agent.id })).status).toBeLessThan(300);
      const computerd = (path: string) => fetch(stackUrls().computerdUrl + path, { method: 'POST', headers: { authorization: `Bearer ${stackUrls().computerdToken}`, 'x-owner-id': account.userId, 'content-type': 'application/json' }, body: '{}' });
      expect((await computerd('/v1/computer/pause')).status).toBe(200);

      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct', memberAgentIds: [agent.id], firstMessage: { text: '帮我在浏览器里打开 https://example.com ，告诉我页面标题是什么。' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId, 240_000);
      const runId: string = finished.data.metadata.juno.run.id;
      expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');

      const chat = await items(account, conversationId);
      const bubbles = chat.filter((item) => item.type === 'agent_message');
      const activity = await toolActivity(`${agent.id}:${conversationId}`);
      // eslint-disable-next-line no-console
      console.log('paused computer', JSON.stringify({ tools: activity.calls.map((call) => call.name), bubbles: bubbles.map((b) => b.markdown) }));
      // It did the work with the browser straight away instead of reporting the computer as unavailable.
      expect(activity.calls.some((call) => /^browser\./.test(call.name) || (call.name === 'tool_call' && /^browser\./.test(String(call.arguments['name']))) || /^computer\./.test(call.name)), JSON.stringify(activity.calls)).toBe(true);
      const text = bubbles.map((b) => b.markdown ?? '').join('\n');
      expect(text).not.toMatch(/暂停|恢复|重新连接|paused|resum|unavailable|不可用/i);
      expect(bubbles[0]?.markdown ?? '', 'the opening line is in the person\'s language').toMatch(CJK);
      expect(bubbles.every((b) => (b.markdown ?? '').trim() !== ''), 'no empty bubble').toBe(true);
      // The harness adds one card for the live screen, once for the run.
      expect(chat.filter((item) => item.type === 'screen_ref' && item.runId === runId), JSON.stringify(chat.map((i) => i.type))).toHaveLength(1);
    } finally {
      events.close();
    }
  }, 300_000);

  it('goes and finds it instead of asking permission or offering setup, and never leaves buttons without words', async () => {
    const account = await createAccount('real-initiative');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await defaultAgent(account);
      const created = await account.api('POST', '/v1/conversations', {
        kind: 'direct', memberAgentIds: [agent.id], firstMessage: { text: '帮我找找有没有讲 auto research 的好文章，给我三篇和各自的要点。' },
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId, 300_000);
      const runId: string = finished.data.metadata.juno.run.id;
      expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');

      const chat = await items(account, conversationId);
      const bubbles = chat.filter((item) => item.type === 'agent_message');
      const activity = await toolActivity(`${agent.id}:${conversationId}`);
      // eslint-disable-next-line no-console
      console.log('initiative', JSON.stringify({ tools: activity.calls.map((call) => call.name), bubbles: bubbles.map((b) => b.markdown), types: chat.map((i) => i.type) }));
      expect(activity.calls.length, 'it used its tools').toBeGreaterThan(0);
      expect(bubbles.every((b) => (b.markdown ?? '').trim() !== ''), 'no bubble that is only buttons').toBe(true);
      expect(bubbles.at(-1)?.markdown ?? '', 'the last message is an answer, not a request for permission').not.toMatch(ASKS_PERMISSION);
      expect(bubbles.at(-1)?.markdown ?? '').toMatch(CJK);
      // No setup offer in the middle of the errand: no Connect/question card before the answer.
      const answerAt = chat.lastIndexOf(bubbles.at(-1) as Item);
      const early = chat.slice(0, answerAt < 0 ? chat.length : answerAt).filter((item) => item.type === 'request' || item.type === 'role_suggestion');
      expect(early, JSON.stringify(early)).toHaveLength(0);
    } finally {
      events.close();
    }
  }, 360_000);
});
