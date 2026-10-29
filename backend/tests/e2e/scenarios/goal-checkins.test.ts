import { describe, expect, it } from 'vitest';
import { createAccount, listItems, listRuns, scriptModel, runNow as runTimerNow, toolCall, type Account } from '../harness/client';

/**
 * Goals that follow up on their own (BACKEND §5.10): a new goal gets one planning run that writes milestones and a first check time;
 * when the user's hourly tick finds the check due the agent advances one step and records it in the timeline without a word to the user,
 * and speaks only when something changed (the final reply is the one exit: an empty one says nothing); a paused goal is never checked.
 * The check-ins land in the agent's own direct chat, which creating the agent opened (it greeted there first).
 */
const HOUR = 3_600_000;

async function runNow(account: Account, job: 'goals' | 'briefing', at: Date): Promise<{ outcome: string }> {
  return runTimerNow('MemoryTimer', account.userId, account.userId, { job, at: at.toISOString() });
}

async function waitForGoal(account: Account, id: string, ok: (goal: any) => boolean, what: string): Promise<any> {
  let last: unknown;
  for (let i = 0; i < 60; i += 1) {
    last = (await account.api('GET', `/v1/goals/${id}`)).body;
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`goal never reached: ${what}: ${JSON.stringify(last)}`);
}

const agentTexts = async (account: Account, conversationId: string): Promise<string[]> =>
  (await listItems(account, conversationId)).filter((item) => item.agentId !== undefined && item.markdown !== undefined).map((item) => item.markdown ?? '');

describe('goal check-ins', () => {
  it('plans a new goal, checks in silently, speaks on a change and leaves a paused goal alone', async () => {
    const alice = await createAccount('goalcheck-alice');
    const bob = await createAccount('goalcheck-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Coach' });
    // Creating the agent opened its direct chat and woke it to speak first; wait for that greeting run before scripting the check-ins.
    let conversationId = '';
    for (let i = 0; i < 60 && conversationId === ''; i += 1) {
      const chats = (await alice.api('GET', '/v1/conversations')).body.items as Array<{ id: string; kind: string; agentIds: string[] }>;
      conversationId = chats.find((chat) => chat.kind === 'direct' && chat.agentIds.includes(agent.body.id))?.id ?? '';
      if (conversationId === '') await new Promise((r) => setTimeout(r, 250));
    }
    expect(conversationId).not.toBe('');
    for (let i = 0; i < 60 && ((await listRuns(alice, conversationId)).length === 0 || !(await listRuns(alice, conversationId)).every((run) => run.status === 'completed')); i += 1) await new Promise((r) => setTimeout(r, 500));
    const greeted = await agentTexts(alice, conversationId);
    expect(greeted).toHaveLength(1);
    const title = 'Learn basic Spanish';
    const firstCheck = new Date(Date.now() + 3 * HOUR);
    const milestones = [
      { title: 'Pick a course', status: 'todo' }, { title: 'Learn 100 words', status: 'todo' }, { title: 'Hold a 5 minute chat', status: 'todo' },
    ];
    // Turns are used in order across the wakes of this chat (the first is the greeting's, already played): plan and a silent check-in end with a
    // blank final reply (nothing is posted); the check-in with news says it as its final reply; "Check now" answers the user in a line.
    const spoken = 'I found a course that fits: Lingoda. Want me to enrol you?';
    scriptModel(`${agent.body.id}:${conversationId}`, [
      { text: 'greeting already sent' },
      { toolCalls: [toolCall('plan','goal_update', { title, summary: 'Planned', milestones, note: 'Plan written', nextCheckAt: firstCheck.toISOString() })] },
      { text: '' },
      { toolCalls: [toolCall('step','goal_update', { title, summary: 'Comparing courses', milestones: [{ title: 'Pick a course', status: 'doing' }, ...milestones.slice(1)], note: 'Compared three courses' })] },
      { text: '' },
      { toolCalls: [toolCall('news','goal_update', { title, summary: 'A course is picked', milestones: [{ title: 'Pick a course', status: 'done' }, ...milestones.slice(1)], note: 'Found a course that fits', nextCheckAt: new Date(Date.now() + 40 * HOUR).toISOString() })] },
      { text: spoken },
      { text: 'still on track' },
    ]);

    // 1. The goal is created; its agent plans it: milestones and the first check time.
    const created = await alice.api('POST', '/v1/goals', { agentId: agent.body.id, kind: 'goal', title });
    expect(created.status).toBe(201);
    const goalId: string = created.body.id;
    expect(Date.parse(created.body.nextCheckAt)).toBeGreaterThan(Date.now() + 23 * HOUR);
    const planned = await waitForGoal(alice, goalId, (goal) => goal.milestones?.length === 3, 'a plan with three milestones');
    expect(planned.milestones.map((m: { status: string }) => m.status)).toEqual(['todo', 'todo', 'todo']);
    expect(planned.nextCheckAt).toBe(firstCheck.toISOString());
    expect(planned.activity.map((a: { text: string }) => a.text)).toContain('Plan written');
    expect(await agentTexts(alice, conversationId)).toEqual(greeted);

    // 2. Before the check time nothing happens; at the first tick after it the agent works one step and stays quiet.
    expect((await runNow(alice, 'goals', new Date(Date.now() + HOUR))).outcome).toBe('wakes:0');
    const tick = new Date(Date.now() + 4 * HOUR);
    expect((await runNow(alice, 'goals', tick)).outcome).toBe('wakes:1');
    const progressed = await waitForGoal(alice, goalId, (goal) => goal.summary === 'Comparing courses', 'silent progress');
    expect(progressed.milestones[0].status).toBe('doing');
    expect(progressed.activity[0]).toMatchObject({ actor: 'agent', kind: 'note', text: 'Compared three courses' });
    // The tick moved the next check a day ahead already (bounded 1 hour to 7 days), so it cannot fire again in a loop.
    expect(Date.parse(progressed.nextCheckAt) - tick.getTime()).toBe(24 * HOUR);
    expect(Date.parse(progressed.lastCheckedAt)).toBe(tick.getTime());
    expect((await runNow(alice, 'goals', new Date(tick.getTime() + HOUR))).outcome).toBe('wakes:0');
    expect(await agentTexts(alice, conversationId)).toEqual(greeted);

    // 3. A day later something changed: the timeline records it and the user hears about it once.
    expect((await runNow(alice, 'goals', new Date(tick.getTime() + 25 * HOUR))).outcome).toBe('wakes:1');
    const changed = await waitForGoal(alice, goalId, (goal) => goal.summary === 'A course is picked', 'news recorded');
    expect(changed.milestones[0].status).toBe('done');
    expect(Date.parse(changed.nextCheckAt) - Date.now()).toBeGreaterThan(39 * HOUR);
    for (let i = 0; i < 60 && (await agentTexts(alice, conversationId)).length === greeted.length; i += 1) await new Promise((r) => setTimeout(r, 500));
    expect(await agentTexts(alice, conversationId)).toEqual([...greeted, spoken]);

    // 4. A paused goal is never checked and cannot be checked by hand; resuming schedules the next check an hour out.
    expect((await alice.api('PATCH', `/v1/goals/${goalId}`, { status: 'paused' })).status).toBe(200);
    expect((await runNow(alice, 'goals', new Date(Date.now() + 10 * 24 * HOUR))).outcome).toBe('wakes:0');
    expect((await alice.api('POST', `/v1/goals/${goalId}/check`)).status).toBe(409);
    const resumed = await alice.api('PATCH', `/v1/goals/${goalId}`, { status: 'active' });
    expect(Date.parse(resumed.body.nextCheckAt) - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(Date.parse(resumed.body.nextCheckAt) - Date.now()).toBeLessThan(70 * 60_000);

    // 5. "Check now" wakes the agent outside the schedule; another account can neither see nor trigger it.
    expect((await alice.api('POST', `/v1/goals/${goalId}/check`)).body).toEqual({ queued: true });
    for (let i = 0; i < 60; i += 1) {
      const runs = await listRuns(alice, conversationId);
      if (runs.length >= 5 && runs.every((run) => ['completed', 'failed', 'stopped'].includes(run.status))) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    // The greeting run and the four goal wakes.
    expect((await listRuns(alice, conversationId)).length).toBe(5);
    expect((await bob.api('POST', `/v1/goals/${goalId}/check`)).status).toBe(404);

    // 6. The daily briefing puts one line per changed goal into the timeline (not the chat), and a day without changes costs nothing.
    scriptModel(`goals:briefing:${alice.userId}`, [{ text: JSON.stringify({ lines: [{ id: goalId, text: 'Course picked; next up: learn 100 words.' }] }) }]);
    const morning = new Date(Date.UTC(2031, 0, 5, 12));
    expect((await runNow(alice, 'briefing', morning)).outcome).toBe('done');
    const briefed = await alice.api('GET', `/v1/goals/${goalId}`);
    expect(briefed.body.activity[0]).toMatchObject({ actor: 'agent', kind: 'note', text: 'Daily briefing: Course picked; next up: learn 100 words.' });
    expect((await runNow(alice, 'briefing', morning)).outcome).toBe('skipped');
    expect((await runNow(alice, 'briefing', new Date(morning.getTime() + 24 * HOUR))).outcome).toBe('skipped');
    // Only what was said reached the chat: the greeting, the news, and the line the user asked for with "Check now".
    expect(await agentTexts(alice, conversationId)).toEqual([...greeted, spoken, 'still on track']);
  });
});
