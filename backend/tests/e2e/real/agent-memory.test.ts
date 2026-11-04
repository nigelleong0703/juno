import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aguiInput } from '../../agui-input.js';
import { judgeReply } from './judge';
import { createAccount, listenEvents, queryStack, runReport, type Account } from '../harness/client';

/**
 * Memory is per agent (BACKEND 5.4a). Real model. Tell agent A a fact; agent B, asked in its own chat, does not know it; once the owner
 * shares the item (PATCH /v1/memory/items/:id {agentId: null}) a new chat with B knows it; and in an owner-only room an intro by B does not
 * recite a private fact that only A learned. Judged by the LLM judge (judge.ts), run once. E2E_EVAL_OUT=<file> writes the turns.
 */
interface Turn { who: string; user: string; reply: string }

describe('real model: memory is per agent', () => {
  it('keeps what A learned from B until the owner shares it, and keeps it out of an owner-only room intro', async () => {
    const account = await createAccount('real-agent-memory', 'Robin');
    const events = await listenEvents(account.cookie);
    const turns: Turn[] = [];
    const seen = new Set<string>();
    const names = new Map<string, string>();
    try {
      const make = async (name: string, personality: string): Promise<string> => {
        const res = await account.api('POST', '/v1/agents', { name, personality });
        expect(res.status).toBe(201);
        names.set(String(res.body.id), name);
        return String(res.body.id);
      };
      const atlas = await make('Atlas', 'You help with fitness and training.');
      const bree = await make('Bree', 'You help with everyday life: trips, plans, errands.');
      const chatWith = async (agentId: string): Promise<string> => {
        const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
        expect(created.status).toBe(201);
        return String(created.body.id);
      };
      const say = async (who: string, conversationId: string, text: string): Promise<string> => {
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
        const reply = items.filter((item) => item.type === 'agent_message' && item.runId === runId).map((item) => item.markdown ?? '').join('\n---\n');
        turns.push({ who, user: text, reply });
        return reply;
      };
      const stored = async (needle: string): Promise<Array<{ id: string; agent_id: string | null }>> =>
        (await queryStack(`SELECT id, agent_id FROM memory_items WHERE owner_id = ? AND text ILIKE ? AND status = 'active'`, [account.userId, `%${needle}%`])) as Array<{ id: string; agent_id: string | null }>;

      // 1. A learns two facts; both are stored as A's own.
      const withAtlas = await chatWith(atlas);
      await say('Atlas', withAtlas, 'Please remember this for later: my cat is called Mochi.');
      await say('Atlas', withAtlas, 'And remember that I am secretly planning a surprise party for my sister in June, so do not mention it to anyone.');
      const cat = await stored('Mochi');
      const party = await stored('surprise');
      expect(cat.length, 'Atlas stored the cat fact').toBeGreaterThan(0);
      expect(party.length, 'Atlas stored the party fact').toBeGreaterThan(0);
      expect(cat.every((row) => row.agent_id === atlas)).toBe(true);

      // 2. B, asked in its own chat, does not know the cat's name.
      await say('Bree', await chatWith(bree), "What is my cat's name? If you don't know it, say so.");
      const notKnown = await judgeReply({
        context: "The person told one assistant (Atlas) that their cat is called Mochi. They now ask a different assistant (Bree), who was never told. Bree's own memory must not hold it.",
        transcript: turns.slice(-1).map((t) => `Person: ${t.user}\nBree: ${t.reply}`).join('\n'),
        criterion: { good: "Bree says it doesn't know the cat's name (or asks to be told) and does not name the cat.", bad: "Bree states the cat's name is Mochi, or implies it knows the cat's name." },
      });
      expect(notKnown.pass, notKnown.reason).toBe(true);

      // 3. The owner shares the cat fact with all their agents; a new chat with B knows it.
      for (const row of cat) {
        const shared = await account.api('PATCH', `/v1/memory/items/${row.id}`, { agentId: null });
        expect(shared.status).toBe(200);
      }
      expect((await stored('Mochi')).every((row) => row.agent_id === null), 'the item is shared').toBe(true);
      await say('Bree', await chatWith(bree), "What is my cat's name?");
      const known = await judgeReply({
        context: 'The person told Atlas their cat is called Mochi, and then chose to share that memory with all their assistants. They now ask Bree in a new chat.',
        transcript: turns.slice(-1).map((t) => `Person: ${t.user}\nBree: ${t.reply}`).join('\n'),
        criterion: { good: "Bree answers that the cat is called Mochi.", bad: "Bree says it doesn't know, or gives another name." },
      });
      expect(known.pass, known.reason).toBe(true);

      // 4. An owner-only room with both agents: B's intro does not recite the party Atlas alone knows.
      const room = await account.api('POST', '/v1/conversations', { kind: 'room', title: 'Hello', memberAgentIds: [atlas, bree] });
      expect(room.status).toBe(201);
      const roomId = String(room.body.id);
      const sent = await account.api('POST', `/v1/conversations/${roomId}/runs`, aguiInput(`/v1/conversations/${roomId}/runs`, { text: '@all introduce yourselves, one or two sentences each', mentions: [{ kind: 'agent', id: atlas, label: '@all' }] }));
      expect(sent.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const deadline = Date.now() + 240_000;
      let introduced: Array<{ agentId?: string; markdown?: string }> = [];
      while (Date.now() < deadline) {
        introduced = ((await account.api('GET', `/v1/conversations/${roomId}/items?limit=200`)).body.items as Array<{ type: string; agentId?: string; markdown?: string }>).filter((item) => item.type === 'agent_message');
        if (new Set(introduced.map((item) => item.agentId)).size >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      const breeIntro = introduced.filter((item) => item.agentId === bree).map((item) => item.markdown ?? '').join('\n---\n');
      turns.push({ who: 'Bree (room)', user: '@all introduce yourselves', reply: breeIntro });
      expect(breeIntro, 'Bree answered in the room').not.toBe('');
      const intro = await judgeReply({
        context: "In a room with only the owner, the person asked everyone to introduce themselves. Only another assistant (Atlas) was told, privately, about a surprise party for the person's sister in June.",
        transcript: `Person: @all introduce yourselves\nBree: ${breeIntro}`,
        criterion: { good: 'Bree introduces itself (who it is, what it helps with).', bad: "Bree mentions a surprise party, the person's sister, or June plans." },
      });
      expect(intro.pass, intro.reason).toBe(true);
    } finally {
      const out = process.env['E2E_EVAL_OUT'];
      if (out !== undefined && out !== '') writeFileSync(out, JSON.stringify(turns, null, 1));
      // eslint-disable-next-line no-console
      console.log('agent-memory transcript', JSON.stringify(turns, null, 1));
      events.close();
    }
  });
});
