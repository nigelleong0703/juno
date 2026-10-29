import { aguiInput } from '../../agui-input.js';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createAccount, insertDocRow, listenEvents, runNow, stackUrls, toolActivity, waitForTranscript } from '../harness/client';

/**
 * Real-model long chat: a conversation with ~10 days of old history (~150k tokens, over the 128k idle floor) is NOT
 * compacted inside the next run; the one-hour idle timer is fired through the run-now route instead of waiting; afterwards the agent
 * must recover tiny details that the summary does not carry (transcript_search) and a big topic
 * (the summary path).
 */
const DAYS = 10;
const PER_DAY = 19;
const TOPICS = ['a weekend trip to Penang', 'meal prep for the week', 'planning the quarterly review', 'a birthday dinner menu', 'fixing a leaky tap', 'a reading list for autumn', 'choosing a running route', 'budgeting for the move'];
const PHRASES = [
  'I looked at a few options yesterday and the prices were all over the place, so I wrote them down in my notes app',
  'my sister suggested starting early in the morning to avoid the crowds, which sounds sensible but costs some sleep',
  'the main trade-off is time against money, and honestly I would rather spend a little more and have a calmer week',
  'we also need to check what is already in the cupboard before buying anything new, otherwise it all gets wasted',
  'the colleague who owns this said the deadline might slip by a few days, so I am keeping a loose schedule for now',
  'last time something similar went wrong because nobody wrote down who was responsible, so this time I made a short list',
];
/** Tiny facts mentioned once in passing inside a long message on the given day; the summary is unlikely to keep them. */
const DETAILS: Array<{ day: number; say: string; ask: string; value: string; itemOnly?: boolean }> = [
  { day: 0, say: 'the cabin wifi password is heron-4471', ask: 'What was the cabin wifi password I mentioned a while ago?', value: 'heron-4471' },
  { day: 0, say: 'the locker code for the gym is 4817', ask: 'What is the locker code for my gym?', value: '4817' },
  { day: 1, say: 'the parcel tracking number is SG7731940KL', ask: 'What was the parcel tracking number I mentioned?', value: 'SG7731940KL' },
  { day: 1, say: 'the plumber is called Mr Haziq and his number ends in 0293', ask: 'What are the last four digits of the plumber\'s number?', value: '0293' },
  { day: 2, say: 'the dentist booking reference is DQ-5582', ask: 'What was my dentist booking reference?', value: 'DQ-5582' },
  { day: 2, say: 'the spare key is under the blue pot on level 7', ask: 'Which level did I say the spare key was on?', value: 'level 7' },
  { day: 3, say: 'the library card number is 20931776', ask: 'What was my library card number?', value: '20931776' },
  { day: 3, say: 'my passport renews in March 2029', ask: 'When does my passport renew?', value: '2029' },
  { day: 4, say: 'the guest room paint is called Misty Fjord', ask: 'What is the guest room paint called?', value: 'Misty Fjord' },
  { day: 4, say: 'the bike lock combination is 6250', ask: 'What is the bike lock combination?', value: '6250' },
  { day: 5, say: 'the vet appointment for the cat is at 3:40 pm', ask: 'What time is the cat\'s vet appointment?', value: '3:40' },
  { day: 5, say: 'the wine we liked was the 2019 Quinta do Vale', ask: 'Which wine did we like?', value: 'Quinta do Vale' },
  { day: 6, say: 'the storage unit is number B-114', ask: 'Which storage unit is mine?', value: 'B-114' },
  { day: 6, say: 'the gate intercom code is 9035', ask: 'What is the gate intercom code?', value: '9035' },
  { day: 1, say: 'the car park bay is C22', ask: 'Which car park bay did I mention?', value: 'C22' },
  { day: 2, say: 'the tailor is named Mrs Okonkwo', ask: 'What is the tailor\'s name?', value: 'Okonkwo' },
  { day: 3, say: 'the coupon code for the shoe shop is STEP-OFF-35', ask: 'What was the shoe shop coupon code?', value: 'STEP-OFF-35' },
  { day: 4, say: 'the allotment plot is number 58', ask: 'Which allotment plot is mine?', value: '58' },
  { day: 5, say: 'the flight confirmation starts with ZX9QTR', ask: 'How does my flight confirmation code start?', value: 'ZX9QTR' },
  { day: 6, say: 'the eye test is booked with Dr Lindqvist', ask: 'Who is my eye test booked with?', value: 'Lindqvist' },
];
// Many more of the same kind, so no summary of a few hundred tokens can carry them all.
const THINGS = ['north', 'south'].flatMap((side) => ['shed', 'garage', 'office door', 'pool gate', 'archive box', 'server room', 'laundry', 'bin store'].map((place) => `${side} ${place}`));
THINGS.forEach((thing, i) => {
  const code = String(1000 + ((i + 3) * 7919) % 9000);
  DETAILS.push({ day: i % 7, say: `the code for the ${thing} is ${code}`, ask: `What is the code for the ${thing}?`, value: code });
});
// Chat messages the compaction never saw (items only, no transcript rows): only transcript_search can find them.
// They are asked only when fewer than two of the details above are missing from the summary.
const HIDDEN = [
  { day: 2, say: 'my locker at the climbing hall is 7342', ask: 'What is my locker number at the climbing hall?', value: '7342' },
  { day: 4, say: 'the vet clinic door code is 5918', ask: 'What is the vet clinic door code?', value: '5918' },
];
const filler = (day: number, n: number): string => {
  const topic = TOPICS[(day + n) % TOPICS.length];
  const parts = Array.from({ length: 6 }, (_, i) => PHRASES[(day * 7 + n * 3 + i) % PHRASES.length]);
  return `About ${topic}: ${parts.join('. ')}. Variant ${day}-${n}.`;
};

const MONITOR = [
  ['I need a new monitor for work, around 27 inches, mostly spreadsheets and some photo editing. Any thoughts on what matters?', 'For mixed office and photo work, look at resolution (1440p is the sweet spot at 27 inches), IPS panel for colour, USB-C with power delivery, and a stand that adjusts in height.'],
  ['I narrowed it down to three: the LG 27UP600, the Samsung S27B800 and the Dell U2724D. The Dell is the most expensive.', 'The Dell U2724D has the best colour accuracy and USB-C hub of the three, so the extra price buys real convenience for your use.'],
  ['OK, final decision: I will go with the Dell U2724D. Ordering it tonight.', 'Great choice, the Dell U2724D should serve you well. Remember to calibrate the colours once it arrives.'],
];

describe('real model: long chat after idle compaction', () => {
  it('compacts right after a run, not inside it, and still finds tiny details and a big topic', async () => {
    const account = await createAccount('real-long');
    const events = await listenEvents(account.cookie);
    const sql = postgres(stackUrls().databaseUrl, { max: 1 });
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Echo' });
      expect(agent.status).toBe(201);
      const agentId: string = agent.body.id;
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId], firstMessage: { text: 'hi' } });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const sessionKey = `${agentId}:${conversationId}`;
      const replied = new Set<string>();
      let finishedAtMs = 0;
      let toolCallsSeen = 0;

      /** Wait for the run started by the last send to finish; returns its reply, wall time and the tools it used. */
      const settle = async (label: string, startedAt: number): Promise<string> => {
        const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !replied.has(e.data.metadata.juno.run.id), 180_000);
        replied.add(finished.data.metadata.juno.run.id);
        finishedAtMs = Date.parse(finished.data.metadata.juno.run.finishedAt ?? '') || Date.now();
        const reply = events.events.filter((e) => e.data.type === 'item.added' && e.data.item.type === 'agent_message' && e.data.item.runId === finished.data.metadata.juno.run.id).map((e) => String(e.data.item.markdown)).join('\n');
        // The transcript is flushed a moment after the run ends: wait until this reply is in it before counting tools.
        const probe = reply.split(/["\n\\]/)[0]!.slice(0, 30);
        if (probe.length > 0) await waitForTranscript(sessionKey, (texts) => texts.some((t) => t.includes(probe)), 20_000);
        const allCalls = (await toolActivity(sessionKey)).calls;
        const tools = allCalls.slice(toolCallsSeen).map((c) => `${c.name}${c.name.startsWith('transcript') ? JSON.stringify(c.arguments).slice(0, 60) : ''}`);
        toolCallsSeen = allCalls.length;
        const [usage] = await sql<Array<{ tokens: number }>>`SELECT (doc->'message'->'usage'->>'input')::int + (doc->'message'->'usage'->>'cacheRead')::int AS tokens FROM transcripts WHERE doc->>'sessionKey' = ${sessionKey} AND doc->'message'->>'role' = 'assistant' AND doc->'message'->'usage'->>'input' IS NOT NULL ORDER BY (doc->>'seq')::int DESC LIMIT 1`;
        console.log(`[long-chat] ${label} (last request ~${usage?.tokens ?? '?'} input tokens): ${Math.round((Date.now() - startedAt) / 1000)}s, run ${finished.data.metadata.juno.run.status}, tools: ${tools.length ? tools.join(',') : 'none'}`);
        console.log(`[long-chat]   reply: ${reply.replace(/\s+/g, ' ').slice(0, 160)}`);
        return reply;
      };
      const hi = await settle('hi', Date.now() - 1);
      expect(hi.length).toBeGreaterThan(0);

      // Seed ~10 old days after the existing rows (ordered by seq), as transcript rows AND chat items.
      const [real] = await sql<Array<{ doc: { seq: number; message: { api: string; provider: string; model: string } } }>>`
        SELECT doc FROM transcripts WHERE doc->>'sessionKey' = ${sessionKey} AND doc->'message'->>'role' = 'assistant' ORDER BY (doc->>'seq')::int DESC LIMIT 1`;
      const [top] = await sql<Array<{ seq: number }>>`SELECT max((doc->>'seq')::int) AS seq FROM transcripts WHERE doc->>'sessionKey' = ${sessionKey}`;
      let seq = (top?.seq ?? 0) + 1;
      let chars = 0;
      const exchanges: Array<{ at: string; user: string; agent: string; itemOnly?: boolean }> = [];
      for (let day = 0; day < DAYS; day += 1) {
        for (let n = 0; n < PER_DAY; n += 1) {
          const at = new Date(Date.UTC(2026, 8, 20 + day, 6 + Math.floor(n * 0.9), (n * 7) % 60, 0)).toISOString();
          const monitor = day === 0 && n < MONITOR.length ? MONITOR[n] : undefined;
          let user = monitor?.[0] ?? `${filler(day, n)} ${filler(day, n + 1)}`;
          // Two details per message from slot 3 on, so there are far more than a short summary can list.
          const slot = DETAILS.filter((d) => d.day === day).slice((n - 3) * 2, (n - 3) * 2 + 2);
          if (n >= 3 && slot.length > 0) user = `${filler(day, n)} ${filler(day, n + 4).replace('. ', `, so ${slot.map((d) => d.say).join(' and ')}, which does not matter much here. `)} ${filler(day, n + 5)}`;
          const agentText = monitor?.[1] ?? `${filler(day, n + 2)} ${filler(day, n + 3)}`;
          exchanges.push({ at, user, agent: agentText });
        }
      }
      for (const h of HIDDEN) {
        DETAILS.push({ ...h, itemOnly: true });
        exchanges.push({ at: new Date(Date.UTC(2026, 8, 20 + h.day, 21, 0, 0)).toISOString(), user: `Short one about the week: ${h.say}.`, agent: 'Noted, thanks for telling me.', itemOnly: true });
      }
      for (const [i, ex] of exchanges.entries()) {
        const at2 = new Date(Date.parse(ex.at) + 60_000).toISOString();
        chars += ex.user.length + ex.agent.length;
        const userId = `tx_seed_${i}_u`;
        const agentTxId = `tx_seed_${i}_a`;
        if (!ex.itemOnly) {
          await insertDocRow('transcripts', account.userId, { id: userId, sessionKey, seq: seq++, message: { role: 'user', content: ex.user, timestamp: Date.parse(ex.at) }, compactionEpoch: 0, at: ex.at }, { agentId, conversationId, kind: sessionKey });
          await insertDocRow('transcripts', account.userId, {
            id: agentTxId, sessionKey, seq: seq++, compactionEpoch: 0, at: at2,
            message: { role: 'assistant', content: [{ type: 'text', text: ex.agent }], api: real?.doc.message.api ?? 'openai-responses', provider: real?.doc.message.provider ?? 'openai', model: real?.doc.message.model ?? 'unknown',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.parse(at2) },
          }, { agentId, conversationId, kind: sessionKey });
        }
        await insertDocRow('items', account.userId, { id: `item_seed_${i}_u`, conversationId, type: 'user_message', text: ex.user, at: ex.at }, { conversationId });
        await insertDocRow('items', account.userId, { id: `item_seed_${i}_a`, conversationId, agentId, type: 'agent_message', markdown: ex.agent, at: at2 }, { agentId, conversationId });
      }
      const [before] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM transcripts WHERE doc->>'sessionKey' = ${sessionKey}`;
      expect(chars).toBeGreaterThan(560_000);

      // A normal message: the run carries the whole ~150k context and must not compact inside itself.
      const noteStart = Date.now();
      await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'Thanks for all of that. Just reply "noted".' }));
      expect((await settle('note', noteStart)).length).toBeGreaterThan(0);
      const [during] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM compactions WHERE doc->>'sessionKey' = ${sessionKey}`;
      expect(during?.n, 'a compaction was written during or right after an in-window run').toBe(0);

      // Fire the idle compaction now instead of waiting an hour. The Session arms its timer when it processes the run's end,
      // a moment after run.finished reaches the client, so retry until it is armed.
      const compactStart = Date.now();
      let outcome = '';
      for (let i = 0; i < 30 && outcome !== 'done'; i += 1) {
        outcome = (await runNow('Session', sessionKey, account.userId)).outcome;
        if (outcome !== 'done') await new Promise((r) => setTimeout(r, 1000));
      }
      expect(outcome).toBe('done');
      const [row] = await sql<Array<{ doc: { summary: string; uptoSeq: number; epoch: number; recentUsers?: string[] } }>>`SELECT doc FROM compactions WHERE doc->>'sessionKey' = ${sessionKey} ORDER BY created_at DESC LIMIT 1`;
      const summary = row?.doc.summary ?? '';
      const checkpoint = row ? `epoch ${row.doc.epoch}, uptoSeq ${row.doc.uptoSeq}, recentUsers ${row.doc.recentUsers?.length ?? 0}` : '';
      console.log(`[long-chat] seeded ${before?.n} transcript rows, ~${Math.round(chars / 4000)}k tokens (chars/4); idle compaction ${Math.round((Date.now() - compactStart) / 1000)}s, summary ${summary.length} chars (~${Math.round(summary.length / 4)} tokens); checkpoint ${checkpoint}; last seeded seq ${seq - 1}`);
      expect(summary, 'no compaction row after idleCompact').not.toBe('');
      expect(summary).toContain('Topics by date');
      console.log('[long-chat] summary:\n' + summary);

      // Search path: details the summary does not carry (and old enough to be outside the kept tail).
      const missing = DETAILS.filter((d) => !summary.includes(d.value));
      const asked = missing.slice(0, 2);
      console.log(`[long-chat] details missing from the summary: ${missing.filter((d) => !d.itemOnly).length}/${DETAILS.length - HIDDEN.length} (plus ${HIDDEN.length} items-only); asking ${asked.map((d) => `${d.value}${d.itemOnly ? ' [items-only]' : ''}`).join(', ')}`);
      const recalled: string[] = [];
      for (const detail of asked) {
        const started = Date.now();
        await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: detail.ask }));
        const reply = await settle(`detail "${detail.value}" (not in summary)`, started);
        if (reply.includes(detail.value)) recalled.push(detail.value);
        else console.log(`[long-chat] "${detail.ask}" got: ${reply.slice(0, 200)}`);
      }
      expect(recalled, 'details missing from the summary were not recovered').toHaveLength(asked.length);

      const monitorStart = Date.now();
      await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'Which monitor did we pick back then?' }));
      expect(await settle('monitor question (summary path)', monitorStart)).toContain('U2724D');
      console.log('[long-chat] tools overall: ' + (await toolActivity(sessionKey)).calls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 80)})`).join(' | '));
    } finally {
      await sql.end();
      events.close();
    }
  });
});
