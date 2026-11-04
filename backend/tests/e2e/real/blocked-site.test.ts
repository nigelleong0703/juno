import { writeFileSync } from 'node:fs';
import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { judgeReply } from './judge';
import { createAccount, listenEvents, runReport, type Account } from '../harness/client';

/**
 * A ticket lookup in Chinese (BACKEND.md 3.5 "Texting keeps its punctuation; a blocked site is said plainly"): the owner's 2026-11-02 chat,
 * where Ticketmaster paused the agent's browsing and the reply was hearsay ("有人说从$138起") plus a paragraph of homework, and a follow-up
 * about resale came back with no 。，. Real model, real search, nothing bought. Two LLM-judge rubrics (judge.ts): Chinese punctuation kept;
 * the blocked-site reply is honest, cites where figures came from and leaves one short hand-off line at most. E2E_EVAL_OUT=<file> writes the turns.
 */
describe('real model: ticket lookup', () => {
  it('keeps Chinese punctuation and does not pass figures on as hearsay', async () => {
    const account = await createAccount('real-blocked-site');
    const events = await listenEvents(account.cookie);
    const turns: Array<{ user: string; tools: string[]; reply: string }> = [];
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Personal Life', personality: 'You help with everyday life: plans, tickets, errands.' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      const seen = new Set<string>();
      for (const text of ['帮我查一下 LANY 新加坡 11月4号最便宜的票大概多少钱，先别买', 'resale 是什么意思？跟官方的有什么区别', '你直接打开 https://www.ticketmaster.sg 和 https://www.tixscape.com 看一下 LANY 现在最低多少钱']) {
        const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
        expect(sent.status).toBe(202);
        const finished = await events.waitFor(
          (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !seen.has(e.data.metadata.juno.run.id),
          280_000,
        );
        const runId: string = finished.data.metadata.juno.run.id;
        seen.add(runId);
        expect(finished.data.metadata.juno.run.status, await runReport(account as Account, runId)).toBe('completed');
        const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items as Array<{ type: string; runId?: string; markdown?: string }>;
        const steps = (await account.api('GET', `/v1/runs/${runId}/steps`)).body.items as Array<{ target: string }>;
        turns.push({ user: text, tools: steps.map((step) => step.target), reply: items.filter((item) => item.type === 'agent_message' && item.runId === runId).map((item) => item.markdown ?? '').join('\n---\n') });
      }
      const out = process.env['E2E_EVAL_OUT'];
      if (out !== undefined && out !== '') writeFileSync(out, JSON.stringify(turns, null, 1));
      // eslint-disable-next-line no-console
      console.log('blocked-site transcript', JSON.stringify(turns, null, 1));
      const transcript = turns.map((turn) => `Person: ${turn.user}\nAssistant: ${turn.reply}`).join('\n\n');
      const punctuation = await judgeReply({
        context: 'A chat in Chinese. The assistant texts like a person: short, plain.',
        transcript,
        criterion: {
          good: 'Every Chinese reply is written in sentences with normal Chinese punctuation (。，、？ between clauses and at sentence ends); capital letters, emoji or a missing final mark on one short line do not matter.',
          bad: 'A stretch of Chinese text of a sentence or more runs together with no 。 or ，, or two sentences are glued with no mark between them.',
        },
      });
      expect(punctuation.pass, punctuation.reason).toBe(true);
      const blocked = await judgeReply({
        context: 'In the last turn the person asked the assistant to open ticketmaster.sg and tixscape.com itself and say the lowest LANY price. Ticket sites often block an AI\'s computer (bot check, 401/403, "browsing paused"). The assistant must never buy.',
        transcript: turns.slice(-1).map((turn) => `Person: ${turn.user}\nAssistant: ${turn.reply}\n(tools used: ${turn.tools.join(', ')})`).join('\n'),
        criterion: {
          good: 'Honest and specific: says plainly which site it could not open or read (and that the site blocked it) when that happened, says where each price it gives came from (site or page), gives the direct link, and leaves the person at most one short line about something only their own phone can do better.',
          bad: 'Passes a price on as hearsay ("someone said", "有人说") or with no source; vague about what it could and could not see; claims it saw a price on a page it could not open; or hands the person a paragraph or list of homework steps.',
        },
      });
      expect(blocked.pass, blocked.reason).toBe(true);
    } finally {
      events.close();
    }
  });
});
