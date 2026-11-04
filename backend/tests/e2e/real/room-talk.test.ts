import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aguiInput } from '../../agui-input.js';
import { judgeReply, type Verdict } from './judge';
import { createAccount, execStack, listItems, listRuns, queryStack, toolActivity, type Account } from '../harness/client';

/**
 * A room with two agents and only the owner (product form B, owner-only room, so the owner's private memory is loaded).
 * "@all introduce yourselves": the intros are about the agents, none recites the owner's memory. "@all talk to each other":
 * the agents answer each other (one opens, the other replies, they go on) and the chain stops at the hop limit. The same real
 * model judges each transcript against a rubric (judgment, not wording); the transcript goes to ROOM_TALK_TRANSCRIPTS for the owner.
 */
const TRANSCRIPTS = process.env['ROOM_TALK_TRANSCRIPTS'] ?? '';

const ROOM_CONTEXT = 'A group chat room in a chat app with two AI agents (Fitness Tracker, Personal Life) and their owner Robin, who reads every message. A message that starts with "@Name" addresses that agent.';

function verdict(good: string, bad: string, transcriptText: string): Promise<Verdict> {
  return judgeReply({ context: ROOM_CONTEXT, transcript: transcriptText, criterion: { good, bad } });
}

async function seedOwnerMemory(account: Account): Promise<void> {
  let [owner] = await queryStack(`SELECT id FROM people WHERE owner_id = ? AND is_owner`, [account.userId]);
  if (owner === undefined) {
    await execStack(`INSERT INTO people (id, owner_id, name, is_owner) VALUES (?, ?, 'Robin', true)`, ['per_' + randomUUID().replaceAll('-', ''), account.userId]);
    [owner] = await queryStack(`SELECT id FROM people WHERE owner_id = ? AND is_owner`, [account.userId]);
  }
  const person = String(owner?.['id']);
  const facts = ['Robin is training for a marathon in March', 'Robin flies to KL on 6 November in the evening', 'Robin wants less sugar and more muscle'];
  for (const [index, text] of facts.entries()) {
    await execStack(
      `INSERT INTO memory_items (id, owner_id, text, kind, file, about_person_id, said_in, audience, created_at, updated_at)
       VALUES (?, ?, ?, 'fact', 'memory', ?, 'app', 'owner', now(), now())`,
      [`mem_roomtalk_${String(index)}_${randomUUID().slice(0, 8)}`, account.userId, text, person],
    );
  }
}

async function post(account: Account, roomId: string, text: string, mentions: Array<{ kind: string; id: string; label: string }>): Promise<void> {
  const sent = await account.api('POST', `/v1/conversations/${roomId}/runs`, aguiInput(`/v1/conversations/${roomId}/runs`, { text, mentions }));
  expect(sent.status).toBe(202);
}

/** Wait until every run in the room is finished and no new agent message has come for a while. */
async function settle(account: Account, roomId: string, quietMs = 25_000, maxMs = 420_000): Promise<void> {
  const started = Date.now();
  let lastCount = -1;
  let lastChange = Date.now();
  while (Date.now() - started < maxMs) {
    const runs = await listRuns(account, roomId);
    const count = (await listItems(account, roomId)).filter((item) => item.type === 'agent_message').length;
    if (count !== lastCount) { lastCount = count; lastChange = Date.now(); }
    const busy = runs.some((run) => run.status === 'running' || run.status === 'queued' || run.status === 'pending');
    if (!busy && count > 0 && Date.now() - lastChange > quietMs) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function transcript(account: Account, roomId: string, names: Map<string, string>): Promise<Array<{ who: string; text: string }>> {
  return (await listItems(account, roomId))
    .filter((item) => item.type === 'agent_message')
    .map((item) => ({ who: names.get(item.agentId ?? '') ?? 'owner', text: item.markdown ?? '' }));
}

describe.each([1])('real model: room talk, round %i', (round) => {
  it('intros are about the agents, and two agents asked to talk answer each other then stop', async () => {
    const account = await createAccount('real-room-talk' + String(round), 'Robin');
    await seedOwnerMemory(account);
    const make = async (name: string, description: string) => {
      const res = await account.api('POST', '/v1/agents', { name, description });
      expect(res.status).toBe(201);
      return { id: String(res.body.id), name };
    };
    const fitness = await make('Fitness Tracker', 'Tracks workouts and training plans');
    const life = await make('Personal Life', 'Helps with everyday life, trips and plans');
    const created = await account.api('POST', '/v1/conversations', { kind: 'room', title: 'Hellooo', memberAgentIds: [fitness.id, life.id] });
    expect(created.status).toBe(201);
    const roomId = String(created.body.id);
    const everyone = [{ kind: 'agent', id: fitness.id, label: '@all' }];
    const names = new Map([[fitness.id, fitness.name], [life.id, life.name]]);

    await post(account, roomId, '@all 大家自我介绍吧', everyone);
    await settle(account, roomId);
    const intros = await transcript(account, roomId, names);
    await post(account, roomId, '@all 你们两个自己聊天吧', everyone);
    await settle(account, roomId);
    const all = await transcript(account, roomId, names);
    const talk = all.slice(intros.length);

    if (TRANSCRIPTS !== '') {
      const lines = [`## Round ${String(round)}`, '', '### @all 大家自我介绍吧', ...intros.map((m) => `- **${m.who}**: ${m.text}`), '', '### @all 你们两个自己聊天吧', ...talk.map((m) => `- **${m.who}**: ${m.text}`), '', ''];
      appendFileSync(TRANSCRIPTS, lines.join('\n'));
    }

    const show = (messages: typeof intros): string => messages.map((m) => `${m.who}: ${m.text}`).join('\n\n');
    const introVerdict = await verdict(
      'Robin asked everyone to introduce themselves. Each agent introduces ITSELF (who it is, what it helps with in general) in a short chat message (about one to three sentences), and brings up nothing about Robin\'s own life: his plans, trips, goals, training or diet. A generic description of its own domain ("I help with workouts") is fine. Both agents answered.',
      '"your marathon in March" or "your KL trip"; a long multi-paragraph or list-style intro; a missing intro from either agent.',
      show(intros),
    );
    const talkVerdict = await verdict(
      'Robin asked the two agents to chat with each other, and it reads like a natural group chat: short alternating lines (one or two sentences, one idea each) where each agent reacts to what the other just said, with at least 3 messages back and forth. It does not narrate to Robin about the conversation or recap it, and it stops naturally (silence, or at most one short line to Robin when there is something for him to decide).',
      'Any message that is an essay, a plan with days or roles in a paragraph, or a list; a message to Robin describing the chat ("we are really chatting", "watch above", "waiting for their reply", "the plan is set") or repeating what was just said; a closing recap of the whole exchange; a runaway of more than about 10 messages; placeholder or garbage messages such as "." or "test".',
      show(talk),
    );
    if (TRANSCRIPTS !== '') appendFileSync(TRANSCRIPTS, `Judge intros: ${JSON.stringify(introVerdict)}\nJudge talk: ${JSON.stringify(talkVerdict)}\n\n`);
    // message_agent is a core tool in a room with agents: no tool_search round trip before it.
    for (const agent of [fitness, life]) {
      const names = (await toolActivity(`${agent.id}:${roomId}`)).calls.map((call) => call.name);
      expect(names, agent.name).toContain('message_agent');
      expect(names, agent.name).not.toContain('tool_search');
    }
    expect(introVerdict, show(intros)).toMatchObject({ pass: true });
    expect(talkVerdict, show(talk)).toMatchObject({ pass: true });
  });
});
