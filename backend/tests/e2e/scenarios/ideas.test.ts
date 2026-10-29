import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listRuns, scriptModel, scriptedChat, runNow as runTimerNow, waitForTranscript, type Account } from '../harness/client';

/**
 * Daily ideas (BACKEND §5.10): the job reads the user's goals and conversations, a model proposes ideas, the code drops the one
 * the agent has no tool for and saves the rest with a prepared draft; accepting starts the agent in a new conversation with the
 * idea's prompt; dismissing keeps the idea from coming back for 14 days. Another account sees none of it.
 */

async function runJob(account: Account, force: boolean): Promise<{ outcome: string }> {
  return runTimerNow('IdeasTimer', account.userId, account.userId, { force });
}

const openIdeas = async (account: Account) => (await account.api('GET', '/v1/ideas?status=open')).body.items as Array<{ id: string; text: string; why?: string; prepared?: { kind: string; ref: string }; action?: { agentId: string; prompt: string } }>;

describe('daily ideas', () => {
  it('saves capable ideas with prepared work, starts the run on accept, and remembers a dismissal', async () => {
    const alice = await createAccount('ideas-alice');
    const bob = await createAccount('ideas-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Helper' });
    expect(agent.status).toBe(201);
    const agentId: string = agent.body.id;
    expect((await alice.api('POST', '/v1/goals', { agentId, kind: 'goal', title: 'Move the Friday meeting', summary: 'Waiting on Priya' })).status).toBe(201);
    await scriptedChat(alice, agentId, [{ text: 'ok' }], 'The Friday meeting moved to Monday, I still need to tell Priya.');

    const note = { title: 'Draft a note to Priya about Monday', content: 'Hi Priya, the meeting moved to Monday.' };
    const proposal = (over: Record<string, unknown> = {}) => ({
      topic: 'priya-monday', title: 'Tell Priya the meeting moved to Monday', why: 'You said you still need to tell Priya (goal: Move the Friday meeting).',
      agentId, prompt: 'Review the draft and polish it for Priya.', requires: ['web_fetch'], prepared: note, ...over,
    });
    scriptModel(`ideas:daily:${alice.userId}`, [
      { text: JSON.stringify({ ideas: [
        proposal(),
        proposal({ topic: 'haggle', title: 'Haggle down the bike on Marketplace', requires: ['marketplace_haggle'], prepared: undefined }),
        proposal({ topic: 'goal-plan', title: 'Break the goal into steps', prompt: 'Add steps to the Friday meeting goal.', requires: [], prepared: undefined }),
      ] }) },
    ]);

    // 1. The job saves the two capable ideas; the one needing a tool the agent lacks is dropped. A second run the same day skips.
    expect((await runJob(alice, false)).outcome).toBe('done');
    const first = await openIdeas(alice);
    expect(first.map((idea) => idea.text).sort()).toEqual(['Break the goal into steps', 'Tell Priya the meeting moved to Monday']);
    const priya = first.find((idea) => idea.text.startsWith('Tell Priya'));
    expect(priya?.why).toContain('goal: Move the Friday meeting');
    expect(priya?.prepared).toMatchObject({ kind: 'draft', ref: expect.stringMatching(/^drafts\/\d{4}-\d{2}-\d{2}-draft-a-note-to-priya-about-monday\.md$/) });
    const draft = ((await alice.api('GET', `/v1/home?path=${encodeURIComponent(priya?.prepared?.ref ?? '')}`)).body.files as Array<{ content: string }>)[0];
    expect(draft?.content).toContain('the meeting moved to Monday');
    expect((await runJob(alice, false)).outcome).toBe('skipped');
    const runs = (await alice.api('GET', '/v1/runs?limit=100')).body.items as Array<{ kind: string; triggerLabel?: string }>;
    expect(runs.filter((run) => run.kind === 'background' && run.triggerLabel === 'Ideas: daily')).toHaveLength(1);

    // 2. Accepting starts the agent in a new conversation with the idea's prompt; a second tap returns the same conversation.
    const accepted = await alice.api('POST', `/v1/ideas/${priya?.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', conversationId: expect.any(String) });
    const conversationId: string = accepted.body.conversationId;
    await waitForTranscript(`${agentId}:${conversationId}`, (messages) => messages.some((text) => text.includes('Review the draft and polish it for Priya.') && text.includes('/juno/drafts/')));
    for (let i = 0; i < 60 && !(await listRuns(alice, conversationId)).some((run) => run.status === 'completed'); i += 1) await new Promise((r) => setTimeout(r, 500));
    expect((await listRuns(alice, conversationId)).some((run) => run.status === 'completed')).toBe(true);
    expect((await alice.api('POST', `/v1/ideas/${priya?.id}/accept`)).body.conversationId).toBe(conversationId);

    // 3. Dismissing keeps the same topic from coming back, even reworded; a new idea still arrives.
    const plan = first.find((idea) => idea.text === 'Break the goal into steps');
    expect((await alice.api('POST', `/v1/ideas/${plan?.id}/dismiss`)).body).toMatchObject({ status: 'dismissed' });
    scriptModel(`ideas:daily:${alice.userId}`, [
      { text: JSON.stringify({ ideas: [proposal({ topic: 'goal-plan', title: 'Split the goal into steps', requires: [], prepared: undefined }), proposal({ topic: 'weekly', title: 'Plan next week', prompt: 'Plan my week.', requires: [], prepared: undefined })] }) },
    ]);
    expect((await runJob(alice, true)).outcome).toBe('done');
    expect((await openIdeas(alice)).map((idea) => idea.text)).toEqual(['Plan next week']);

    // 4. Another account sees none of it and cannot act on it.
    expect(await openIdeas(bob)).toEqual([]);
    expect((await bob.api('POST', `/v1/ideas/${plan?.id}/accept`)).status).toBe(404);
    expect((await bob.api('GET', `/v1/home?path=drafts/`)).body.files).toEqual([]);
  });

  it('hands the day\'s notice to the default agent as one background check, and starts nothing without one', async () => {
    const alice = await createAccount('notice-alice');
    const bob = await createAccount('notice-bob');
    const check = 'Check the air quality in Singapore today and tell the user if it is unhealthy.';
    // Signup gives every account its default agent and chat; the notice wakes that agent there (after its greeting turn).
    const defaultChat = async (account: typeof alice, turns: Array<{ text: string }>): Promise<string> => {
      const agentId: string = (await account.api('GET', '/v1/agents')).body.items[0].id;
      const conversationId: string = (await account.api('GET', '/v1/conversations')).body.items[0].id;
      for (let i = 0; i < 60 && !(await listRuns(account, conversationId)).some((run) => run.status === 'completed'); i += 1) await new Promise((r) => setTimeout(r, 500));
      scriptModel(`${agentId}:${conversationId}`, [{ text: 'greeting' }, ...turns]);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'I live in Singapore and run outdoors every morning.' }))).status).toBe(202);
      return `${agentId}:${conversationId}`;
    };
    const sessionKey = await defaultChat(alice, [{ text: 'ok' }, { text: 'Nothing worth telling the user.' }]);
    await defaultChat(bob, [{ text: 'ok' }]);
    scriptModel(`ideas:daily:${alice.userId}`, [{ text: JSON.stringify({ ideas: [], notice: { text: check } }) }]);
    scriptModel(`ideas:daily:${bob.userId}`, [{ text: JSON.stringify({ ideas: [] }) }]);

    // A notice becomes one wake for the agent with the check; the owner has no proactive rules yet, so none ride along and no file is made.
    expect((await runJob(alice, false)).outcome).toBe('done');
    const transcript = await waitForTranscript(sessionKey, (messages) => messages.some((text) => text.includes(check)));
    const wake = transcript.find((text) => text.includes(check)) ?? '';
    expect(wake).not.toContain('proactive preferences');
    expect((await alice.api('GET', '/v1/home?path=PROACTIVE_PREFERENCES.md')).body.files).toEqual([]);

    // No notice, no run.
    expect((await runJob(bob, false)).outcome).toBe('done');
    await new Promise((r) => setTimeout(r, 2_000));
    const runs = (await bob.api('GET', '/v1/runs?limit=100')).body.items as Array<{ triggerLabel?: string }>;
    expect(runs.filter((run) => run.triggerLabel === 'Daily check')).toHaveLength(0);
  });
});
