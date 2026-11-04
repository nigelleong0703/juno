import { writeFileSync } from 'node:fs';
import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport } from '../harness/client';

/**
 * Casual chat reply style with a real model (BACKEND.md §3.5 "Reply style"; owner 2026-11-02: replies read less clean than
 * Cue's). 17 casual / explanatory / follow-up prompts in Chinese and English, in three conversations. Every reply is scored
 * against a written rubric, mechanically, so two prompt versions can be compared on the same model:
 *   concise      the reply fits the length budget of its prompt (casual 180 chars, explanation 320, a requested long answer 700)
 *   no_offer     the last bubble is not a trailing offer or follow-up question ("要我…吗", "Want me to…")
 *   no_emoji     the user used none, the reply uses none
 *   no_list      no bullet/numbered lines, headings or bold (unless the person asked for a list)
 *   no_filler    no opener such as "好的！" "收到" "Sure" and no apology/acknowledgement line in front of the answer
 * "Answers the question" and "natural tone" are read by a person from the transcript (E2E_EVAL_OUT=<file> writes it).
 * The assertions stay loose: wording is never checked, only these shape signals over the whole set.
 */
interface Prompt { id: string; text: string; budget: number }

const EMOJI = /\p{Extended_Pictographic}/u;
const LIST = /^\s*([-*•]|\d+[.)、])\s|^#{1,6}\s|\*\*/m;
const OFFER = /(要我|需要我|要不要我|想让我|需不需要|要不要|Want me|Would you like|Shall I|Should I|Do you want me|Let me know if|I can also|随时(叫|找|告诉)我|any ?time|如果你(需要|想)|你(想|要)(先|再)?[^。！？\n]{0,12}(吗|呢)[?？]|(我帮你|我可以帮你|I can help you)[^。！\n]{0,14}(看看|查查|找找|挑|安排|规划|整理|pick|find|check)|[?？]\s*$)/i;
const FILLER = /^\s*(好的|好嘞|好哒|好，|好!|好！|收到|没问题|当然|明白|懂了|哈哈|哎呀|Sure|Of course|Absolutely|Great question|OK[,.!]|Okay[,.!]|Got it|Alright)/i;

const THREAD_CUE: Prompt[] = [
  { id: 'cue1', text: '你怎么发回复的呢', budget: 180 },
  { id: 'cue2', text: '没看懂 解释给我看', budget: 220 },
  { id: 'cue3', text: '调用聊天的发送功能是什么意思', budget: 220 },
];
const THREAD_MISC: Prompt[] = [
  { id: 'tired', text: '今天好累啊', budget: 120 },
  { id: 'latte', text: "what's the difference between a latte and a flat white", budget: 320 },
  { id: 'api', text: "I don't get what an API is", budget: 320 },
  { id: 'remind', text: '提醒我明天早上9点给妈妈打电话', budget: 120 },
  { id: 'weekend', text: '能帮我想想周末去哪玩吗', budget: 180 },
  { id: 'thanks', text: '谢谢！', budget: 60 },
  { id: 'sky', text: '为什么天空是蓝色的', budget: 220 },
  { id: 'abilities', text: 'what can u do', budget: 320 },
  { id: 'everest', text: '珠穆朗玛峰有多高', budget: 80 },
  { id: 'movies', text: '最近有什么好看的电影推荐吗，凭你知道的说，不用搜', budget: 260 },
  { id: 'phone', text: 'iPhone 和安卓我该选哪个', budget: 260 },
];
const THREAD_LONG: Prompt[] = [
  { id: 'long', text: '详细介绍一下新加坡的公共交通，我下周第一次去。不用搜，凭你知道的说', budget: 700 },
  { id: 'follow', text: '那地铁和公交哪个便宜', budget: 220 },
  { id: 'unclear', text: '没看懂 EZ-Link 是啥', budget: 220 },
];

interface Scored { id: string; user: string; reply: string; chars: number; score: Record<'concise' | 'no_offer' | 'no_emoji' | 'no_list' | 'no_filler', boolean> }

describe('real model: casual reply style', () => {
  it('answers casual, explanatory and follow-up chat in short plain messages without offers, emoji or lists', async () => {
    const account = await createAccount('real-casual-style');
    const events = await listenEvents(account.cookie);
    const scored: Scored[] = [];
    try {
      const seenRuns = new Set<string>();
      const agent = await account.api('POST', '/v1/agents', { name: 'Tavi' });
      expect(agent.status).toBe(201);

      const runThread = async (prompts: Prompt[]): Promise<void> => {
        const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
        expect(created.status).toBe(201);
        const conversationId: string = created.body.id;
        for (const prompt of prompts) {
          const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: prompt.text }));
          expect(sent.status).toBe(202);
          const finished = await events.waitFor(
            (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !seenRuns.has(e.data.metadata.juno.run.id),
            240_000,
          );
          const runId: string = finished.data.metadata.juno.run.id;
          seenRuns.add(runId);
          expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');
          const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
          const bubbles = (items.body.items as Array<{ type: string; runId?: string; markdown?: string }>)
            .filter((item) => item.type === 'agent_message' && item.runId === runId)
            .map((item) => item.markdown ?? '');
          expect(bubbles.length, `no reply for: ${prompt.text}`).toBeGreaterThan(0);
          const reply = bubbles.join('\n\n');
          const last = bubbles[bubbles.length - 1] ?? '';
          const chars = reply.replace(/\s+/g, '').length;
          scored.push({
            id: prompt.id, user: prompt.text, reply, chars,
            score: {
              concise: chars <= prompt.budget,
              no_offer: !OFFER.test(last.trim().split(/\n/).slice(-2).join('\n')),
              no_emoji: [...reply.matchAll(new RegExp(EMOJI.source, 'gu'))].length <= 1,
              no_list: !LIST.test(reply),
              no_filler: !bubbles.some((b, i) => i === 0 && FILLER.test(b)),
            },
          });
        }
      };

      await runThread(THREAD_CUE);
      await runThread(THREAD_MISC);
      await runThread(THREAD_LONG);

      const keys = ['concise', 'no_offer', 'no_emoji', 'no_list', 'no_filler'] as const;
      const totals = Object.fromEntries(keys.map((k) => [k, scored.filter((s) => s.score[k]).length]));
      // eslint-disable-next-line no-console
      console.log('casual-reply-style totals (of ' + scored.length + ')', totals);
      // eslint-disable-next-line no-console
      console.log('casual-reply-style transcript', JSON.stringify(scored.map((s) => ({ id: s.id, chars: s.chars, fail: keys.filter((k) => !s.score[k]), reply: s.reply })), null, 1));
      const out = process.env.E2E_EVAL_OUT;
      if (out !== undefined && out !== '') writeFileSync(out, JSON.stringify({ totals, scored }, null, 1));

      // Loose, over the whole set: at most one emoji per reply (owner: emoji on, used lightly); trailing offers and lists stay rare.
      const failing = (k: (typeof keys)[number]) => scored.filter((s) => !s.score[k]).map((s) => s.id);
      expect(failing('no_emoji'), JSON.stringify(scored.map((s) => s.reply))).toEqual([]);
      expect(failing('no_offer').length, 'trailing offers: ' + failing('no_offer').join(',')).toBeLessThanOrEqual(3); // a clarifying question the agent cannot go on without ("你在哪个城市") is allowed and counts here
      expect(failing('no_list'), 'markdown lists in casual chat').toEqual([]);
    } finally {
      events.close();
    }
  }, 1_800_000);
});
