import { describe, expect, it } from 'vitest';
import { createAccount, runNow as runTimerNow, scriptModel, scriptedChat, type Account } from '../harness/client';

/**
 * Proactive preferences (BACKEND §5.10): a "never" button press on an idea writes a rule in the fixed-format file, the daily ideas
 * job then skips that topic in code (even reworded and even when the model proposes it again), the rules API lists, keeps and deletes
 * rules, and another account sees none of it. The silence question and the daily cap are covered by unit tests.
 */

const runJob = (account: Account, force: boolean): Promise<{ outcome: string }> => runTimerNow('IdeasTimer', account.userId, account.userId, { force });
const openIdeas = async (account: Account) => (await account.api('GET', '/v1/ideas?status=open')).body.items as Array<{ id: string; text: string; key?: string }>;
const rules = async (account: Account) => (await account.api('GET', '/v1/proactive/rules')).body.items as Array<{ id: string; kind: string; scope: string; strength?: string; text: string; source: string; review?: string; dueForReview: boolean }>;

describe('proactive preferences', () => {
  it('a never press becomes a rule, the ideas job skips the topic from then on, and the rules API manages it', async () => {
    const alice = await createAccount('prefs-alice');
    const bob = await createAccount('prefs-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Helper' });
    const agentId: string = agent.body.id;
    await scriptedChat(alice, agentId, [{ text: 'ok' }], 'I like to follow the cricket and plan my groceries.');
    const proposal = (over: Record<string, unknown> = {}) => ({ topic: 'cricket', verb: 'follow', title: 'Follow the cricket scores tonight', why: 'You said you follow the cricket.', agentId, prompt: 'Tell me the scores.', requires: [], ...over });
    const groceries = proposal({ topic: 'groceries', verb: 'plan', title: 'Plan the week\'s groceries', why: 'You said you plan your groceries.', prompt: 'Plan my groceries.' });

    // 1. The job offers both; the owner presses "Never" on the cricket idea.
    scriptModel(`ideas:daily:${alice.userId}`, [{ text: JSON.stringify({ ideas: [proposal(), groceries] }) }]);
    expect((await runJob(alice, false)).outcome).toBe('done');
    const first = await openIdeas(alice);
    expect(first.map((idea) => idea.text).sort()).toEqual(["Follow the cricket scores tonight", "Plan the week's groceries"]);
    expect(first.find((idea) => idea.text.startsWith('Follow'))?.key).toBe('cricket|follow');
    const cricket = first.find((idea) => idea.text.startsWith('Follow'));
    const pressed = await alice.api('POST', '/v1/proactive/feedback', { target: { kind: 'idea', id: cricket?.id }, action: 'never' });
    expect(pressed.status).toBe(200);
    expect(pressed.body.rule).toMatchObject({ kind: 'dont', strength: 'never', scope: 'topic', text: 'Cricket', source: 'You tapped Never on the idea "Follow the cricket scores tonight"', dueForReview: false });
    expect(pressed.body.idea).toMatchObject({ status: 'dismissed' });

    // 2. The file holds the rule in the fixed format; the API lists it; another account has none and cannot act on it.
    const file = ((await alice.api('GET', '/v1/home?path=PROACTIVE_PREFERENCES.md')).body.files as Array<{ content: string }>)[0];
    expect(file?.content).toContain("## Don't tell me\n- Cricket | id: ");
    expect(file?.content).toContain('source: "You tapped Never on the idea \\"Follow the cricket scores tonight\\""');
    expect((await rules(alice)).map((rule) => rule.text)).toEqual(['Cricket']);
    expect(await rules(bob)).toEqual([]);
    expect((await bob.api('DELETE', `/v1/proactive/rules/${pressed.body.rule.id}`)).status).toBe(404);
    expect((await bob.api('POST', '/v1/proactive/feedback', { target: { kind: 'idea', id: cricket?.id }, action: 'never' })).status).toBe(404);

    // 3. The next job run: the model proposes the cricket idea again, reworded, and a new one; code drops the cricket one.
    scriptModel(`ideas:daily:${alice.userId}`, [{ text: JSON.stringify({ ideas: [proposal({ title: 'Check the IPL cricket scores' }), proposal({ topic: 'flights', verb: 'book', title: 'Book the Tokyo flights', why: 'You said you want to go to Tokyo.', prompt: 'Find Tokyo flights.' })] }) }]);
    expect((await runJob(alice, true)).outcome).toBe('done');
    expect((await openIdeas(alice)).map((idea) => idea.text).sort()).toEqual(['Book the Tokyo flights', "Plan the week's groceries"]);

    // 4. A soft rule has a review date and can be kept; a hard one has none; deleting removes it.
    const flights = (await openIdeas(alice)).find((idea) => idea.text.startsWith('Book'));
    const less = await alice.api('POST', '/v1/proactive/feedback', { target: { kind: 'idea', id: flights?.id }, action: 'less' });
    expect(less.body.rule).toMatchObject({ kind: 'less', strength: 'less', review: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect((await alice.api('PATCH', `/v1/proactive/rules/${less.body.rule.id}`, { keep: true })).body).toMatchObject({ id: less.body.rule.id, dueForReview: false });
    expect((await alice.api('PATCH', `/v1/proactive/rules/${pressed.body.rule.id}`, { keep: true })).status).toBe(404);
    expect((await alice.api('DELETE', `/v1/proactive/rules/${pressed.body.rule.id}`)).status).toBe(200);
    expect((await rules(alice)).map((rule) => rule.kind)).toEqual(['less']);
  });
});
