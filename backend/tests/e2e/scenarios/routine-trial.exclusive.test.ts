import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { advanceClock, createAccount, listItems, listRuns, listenEvents, queryStack, scriptModel, scriptedChat, stackNow, toolCall, type Account } from '../harness/client';

/**
 * BACKEND §3.6.4: a routine the agent started on its own (from a run nobody waits on) starts on trial. Its first run says and sends nothing: the
 * speaking tool is recorded as "would have" and the person gets one plain question in the chat. A routine the person asked for in the chat is
 * not on trial and runs normally. Answering "开启" turns the trial routine on: its next run speaks.
 * Exclusive because it moves the stack's clock by three hours, which would fire other scenarios' monitors and expire their waits.
 */
async function routineOf(account: Account, id: string): Promise<Record<string, unknown>> {
  return (await account.api('GET', `/v1/routines/${id}`)).body;
}

/**
 * The routine's timer has settled: it has a next run, nothing is queued for it, and the newest waiting fire is the timer's current
 * generation. Every create, update and fire sends one arm (a fire sends the arm for the next occurrence when it finishes), and writing the
 * routine's `nextRunAt` back sends none. A fire of an older generation is dropped when it comes due, so jumping the clock while an arm is
 * still queued loses that occurrence (the arm then runs after the jump and plans the next hour instead). The state has to hold for two seconds.
 */
async function armed(account: Account, id: string): Promise<void> {
  const timer = "service = 'RoutineTimer' AND key = ?";
  let steady = 0;
  for (let i = 0; i < 240; i += 1) {
    const queued = await queryStack(`SELECT handler, status, input::text AS input FROM invocations WHERE ${timer} AND status <> 'done'`, [id]);
    const generation = Number((await queryStack(`SELECT (state::json->'state'->>'armGeneration') AS g FROM objects WHERE ${timer}`, [id]))[0]?.['g']);
    const newest = Math.max(0, ...queued.filter((row) => row['handler'] === 'fire').map((row) => Number((JSON.parse(String(row['input'])) as { generation: number }).generation)));
    const settled = (await routineOf(account, id))['nextRunAt'] !== undefined && queued.every((row) => row['handler'] === 'fire') && newest === generation;
    steady = settled ? steady + 1 : 0;
    if (steady >= 8) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('routine ' + id + ' never settled: ' + JSON.stringify(await queryStack(`SELECT handler, status, left(input::text, 120) AS input FROM invocations WHERE ${timer} ORDER BY created_at`, [id])));
}

/**
 * Every run of the chat has finished for good: its durable invocation is done, so the chat's session is free. A routine that comes due while
 * its delivery chat is still busy with a run is skipped (BACKEND 3.6, "the last one is still running"), and the card appears a moment before
 * the run that raised it has released the session.
 */
async function chatSettled(account: Account, conversationId: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    const ids = (await listRuns(account, conversationId)).map((run) => run.id);
    const open = ids.length === 0 ? [] : await queryStack(`SELECT id FROM invocations WHERE service = 'Run' AND status <> 'done' AND key IN (${ids.map(() => '?').join(',')})`, ids);
    if (open.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the runs of ' + conversationId + ' never finished');
}

/** The next top of the hour (plus 30 s) arrives: schedules that were armed fire. */
const nextHour = (): Promise<void> => advanceClock(3_600_000 - (stackNow() % 3_600_000) + 30_000);

describe('a routine the agent started on its own', () => {
  it('records what its first run would have sent and asks; a routine the person asked for runs normally', async () => {
    const account = await createAccount('routine-trial');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Brief' });
      expect(agent.status).toBe(201);
      const chatA = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(chatA.status).toBe(201);
      const a: string = chatA.body.id;
      const tag = randomUUID().slice(0, 6);
      const brief = `BRIEF-${tag}`;
      const say = (id: string, text: string) => ({ toolCalls: [toolCall(id, 'send_message', { kind: 'text', purpose: 'result', text })] });
      // Chat A: a scheduled "maker" run creates a routine by itself; that routine's runs speak (trial run first, then after "开启").
      scriptModel(`${agent.body.id}:${a}`, [
        { toolCalls: [toolCall('make', 'state_update', { target: 'routine', action: 'create', name: 'Morning brief', prompt: 'send the brief', schedule: '0 * * * *' })] },
        { text: 'Set up the brief routine.' },
        say('say-1', brief), { text: 'Trial run done.' },
        say('say-2', brief), { text: 'Sent the brief.' },
      ]);
      // Chat B: the person asks in the chat, so the routine the agent makes is theirs.
      const requested = `ASKED-${tag}`;
      const b = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('make-b', 'state_update', { target: 'routine', action: 'create', name: 'Asked brief', prompt: 'send the brief', schedule: '0 * * * *' })] },
        { text: 'Done, it will run every hour.' },
        say('say-b', requested), { text: 'Sent.' },
      ], 'Every hour send me a brief');
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === b.conversationId, 60_000);

      const maker = await account.api('POST', '/v1/routines', {
        name: 'Maker', agentId: agent.body.id, instructions: 'make the brief routine', enabled: true,
        trigger: { kind: 'schedule', cron: '0 * * * *', human: 'every hour', tz: 'UTC' },
        delivery: { channel: 'chat', target: a }, notify: { mode: 'always' },
      });
      expect(maker.status).toBe(201);
      const listed = async () => (await account.api('GET', '/v1/routines')).body.items as Array<Record<string, unknown>>;
      let asked = (await listed()).find((routine) => routine['name'] === 'Asked brief');
      expect(asked, 'the routine the person asked for exists').toBeDefined();
      expect(asked?.['preview'], 'and is not on trial').toBeUndefined();
      await armed(account, String(asked?.['id']));
      await armed(account, maker.body.id);

      // The hour passes: the maker run creates its routine; the person's routine runs and says its piece.
      await nextHour();
      let trial: Record<string, unknown> | undefined;
      for (let i = 0; i < 80 && trial === undefined; i += 1) {
        trial = (await listed()).find((routine) => routine['name'] === 'Morning brief');
        if (trial === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(trial, 'the maker run created a routine').toBeDefined();
      const trialId = String(trial?.['id']);
      expect(trial?.['preview'], 'made by a run nobody waits on: on trial').toBeDefined();
      for (let i = 0; i < 80 && !(await listItems(account, b.conversationId)).some((item) => item.markdown === requested); i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
      expect((await listItems(account, b.conversationId)).filter((item) => item.markdown === requested), 'the routine the person asked for sent normally').toHaveLength(1);
      await account.api('POST', `/v1/routines/${maker.body.id}/toggle`, { enabled: false });
      asked = (await listed()).find((routine) => routine['name'] === 'Asked brief');
      await account.api('POST', `/v1/routines/${String(asked?.['id'])}/toggle`, { enabled: false });
      await armed(account, trialId);
      await chatSettled(account, a);

      // Its first run: nothing is sent, and one question comes to the chat.
      await nextHour();
      let card: { id: string; summary: string; status: string } | undefined;
      for (let i = 0; i < 120 && card === undefined; i += 1) {
        const requests = (await account.api('GET', `/v1/requests?conversationId=${a}`)).body.items as Array<{ id: string; kind: string; summary: string; status: string }>;
        card = requests.find((request) => request.kind === 'question');
        if (card === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(card?.summary).toBe(`Trial run of Morning brief: it would have sent a message "${brief}". Turn it on?`);
      expect(card?.status).toBe('pending');
      expect((await listItems(account, a)).filter((item) => item.type === 'agent_message'), 'the trial run said nothing').toEqual([]);

      // 开启: the routine is on, and its next run speaks.
      const answered = await account.api('POST', `/v1/requests/${card?.id}/resolve`, { action: 'answer', answers: { preview: 'on' } });
      expect(answered.status).toBe(200);
      let stored = await routineOf(account, trialId);
      for (let i = 0; i < 40 && stored['preview'] !== undefined; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        stored = await routineOf(account, trialId);
      }
      expect(stored['preview']).toBeUndefined();
      expect(stored['enabled']).toBe(true);
      await chatSettled(account, a);
      await armed(account, trialId);
      await nextHour();
      for (let i = 0; i < 120 && !(await listItems(account, a)).some((item) => item.markdown === brief); i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
      expect((await listItems(account, a)).filter((item) => item.type === 'agent_message').map((item) => item.markdown)).toEqual([brief]);
      await account.api('POST', `/v1/routines/${trialId}/toggle`, { enabled: false });
    } finally {
      events.close();
    }
  }, 240_000);
});
