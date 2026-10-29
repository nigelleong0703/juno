import { describe, expect, it } from 'vitest';
import { createAccount, diagnose, listItems, listRuns, listenEvents, runNow, toolActivity, transcriptTexts, type Account } from '../harness/client';

/**
 * A goal check-in with nothing to tell, with a real model (BACKEND §3.3b, §5.10): the agent records the step in the goal timeline and
 * ends with finish_quietly, so nothing reaches the chat: no placeholder like "(empty)" or "no update". Shape checks only.
 */
const HOUR = 3_600_000;

const agentTexts = async (account: Account, conversationId: string): Promise<string[]> =>
  (await listItems(account, conversationId)).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');

const settled = async (account: Account, conversationId: string, atLeast: number): Promise<void> => {
  for (let i = 0; i < 480; i += 1) {
    const runs = await listRuns(account, conversationId);
    if (runs.length >= atLeast && runs.every((run) => ['completed', 'failed', 'stopped', 'blocked'].includes(run.status))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('runs never settled');
};

describe('real model: a goal check-in where nothing changed', () => {
  it('records the step and says nothing', async () => {
    const account = await createAccount('real-quiet-checkin');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Coach' });
      expect(agent.status).toBe(201);
      const agentId: string = agent.body.id;
      // Creating the agent opened its direct chat and woke it to speak first.
      let conversationId = '';
      for (let i = 0; i < 120 && conversationId === ''; i += 1) {
        const chats = (await account.api('GET', '/v1/conversations')).body.items as Array<{ id: string; kind: string; agentIds: string[] }>;
        conversationId = chats.find((chat) => chat.kind === 'direct' && chat.agentIds.includes(agentId))?.id ?? '';
        if (conversationId === '') await new Promise((r) => setTimeout(r, 250));
      }
      expect(conversationId).not.toBe('');
      await settled(account, conversationId, 1);
      const sessionKey = `${agentId}:${conversationId}`;

      const created = await account.api('POST', '/v1/goals', {
        agentId, kind: 'goal', title: 'Renew my passport before it expires in March 2028 (renewals open in mid 2027, nothing can be done earlier). Plan it without due dates on the milestones.',
      });
      expect(created.status).toBe(201);
      const goalId: string = created.body.id;
      let planned: { milestones?: unknown[]; nextCheckAt: string } = created.body;
      for (let i = 0; i < 480 && (planned.milestones?.length ?? 0) === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        planned = (await account.api('GET', `/v1/goals/${goalId}`)).body;
      }
      if ((planned.milestones?.length ?? 0) === 0) await diagnose('quiet-checkin', account, conversationId, sessionKey);
      expect(planned.milestones?.length ?? 0, 'the agent planned the goal: ' + JSON.stringify(planned)).toBeGreaterThan(0);
      await settled(account, conversationId, 2);

      const messagesBefore = await agentTexts(account, conversationId);
      const quietCalls = async (): Promise<number> => (await toolActivity(sessionKey)).results.filter((result) => result.toolName === 'finish_quietly').length;
      const quietBefore = await quietCalls();
      const unreadBefore: number = (await account.api('GET', `/v1/conversations/${conversationId}`)).body.unreadCount;
      const runsBefore = (await listRuns(account, conversationId)).length;

      // The scheduled check falls due: nothing has changed since planning.
      const outcome = await runNow('MemoryTimer', account.userId, account.userId, { job: 'goals', at: new Date(Date.parse(planned.nextCheckAt) + HOUR).toISOString() });
      expect(outcome.outcome).toBe('wakes:1');
      await settled(account, conversationId, runsBefore + 1);

      const activity = await toolActivity(sessionKey);
      // eslint-disable-next-line no-console
      console.log('quiet-checkin', JSON.stringify({ calls: activity.calls.map((call) => call.name === 'tool_call' ? String(call.arguments['name']) : call.name === 'tool_search' ? 'tool_search ' + JSON.stringify(call.arguments) : call.name), messages: await agentTexts(account, conversationId) }));
      // This must be the scheduled path: the manual or deadline wording would mean a different (attended) wake.
      const wakes = (await transcriptTexts(sessionKey)).filter((t) => t.includes('Goal "'));
      const lastWake = wakes.at(-1) ?? '';
      expect(lastWake, 'the last wake is the scheduled check-in: ' + lastWake.slice(-400)).toContain('It is time to check in on this goal');
      expect(await agentTexts(account, conversationId), 'no message from the check-in').toEqual(messagesBefore);
      expect(await quietCalls(), 'the check-in ended with finish_quietly').toBeGreaterThan(quietBefore);
      expect((await account.api('GET', `/v1/conversations/${conversationId}`)).body.unreadCount, 'the check-in left the unread count as it was').toBe(unreadBefore);
    } finally {
      events.close();
    }
  }, 900_000);
});
