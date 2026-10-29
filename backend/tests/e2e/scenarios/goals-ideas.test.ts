import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, waitForToolActivity } from '../harness/client';

/**
 * Goals and ideas: what the agent writes with goal_update / suggest is what the page lists and edits through
 * /v1/goals and /v1/ideas, the changes arrive as live events, and another account sees none of it.
 */
describe('goals and ideas', () => {
  it('shares owner-isolated goals and ideas between the agent and the page', async () => {
    const alice = await createAccount('goals-alice');
    const bob = await createAccount('goals-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Planner' });
    expect(agent.status).toBe(201);
    const events = await listenEvents(alice.cookie);
    try {
      const steps = [{ text: 'Find dates', done: true }, { text: 'Book flights', done: false }];
      const { sessionKey } = await scriptedChat(alice, agent.body.id, [
        { toolCalls: [toolCall('g1', 'goal_update', { title: 'Plan Tokyo trip', summary: 'Just started' })] },
        // Same title and no id: the agent's own goal is updated, not duplicated.
        { toolCalls: [toolCall('g2', 'goal_update', { title: 'Plan Tokyo trip', summary: 'Dates found', steps })] },
        { toolCalls: [toolCall('s1', 'suggest', { text: 'Want me to compare hotels?', prompt: 'Compare hotels in Shinjuku' })] },
        { toolCalls: [toolCall('s2', 'suggest', { text: 'Want me to compare hotels?', prompt: 'Compare hotels in Shinjuku' })] },
        { toolCalls: [toolCall('s3', 'suggest', { text: 'Want a packing list?', prompt: 'Write a packing list' })] },
        { text: 'done' },
      ], 'help me plan a trip to Tokyo');

      const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 5);
      expect(activity.results.map((r) => [r.toolName, r.isError])).toEqual([
        ['goal_update', false], ['goal_update', false], ['suggest', false], ['suggest', true], ['suggest', false],
      ]);

      await events.waitFor((e) => e.data.type === 'goal.updated' && e.data.goal.summary === 'Dates found');
      await events.waitFor((e) => e.data.type === 'idea.updated' && e.data.idea.text === 'Want a packing list?');

      const goals = await alice.api('GET', `/v1/goals?agentId=${agent.body.id}&status=active`);
      expect(goals.status).toBe(200);
      expect(goals.body.items).toHaveLength(1);
      const goal = goals.body.items[0];
      expect(goal).toMatchObject({ agentId: agent.body.id, kind: 'goal', title: 'Plan Tokyo trip', summary: 'Dates found', status: 'active', steps });

      // The page edits the goal.
      const paused = await alice.api('PATCH', `/v1/goals/${goal.id}`, { status: 'paused', summary: 'On hold' });
      expect(paused.body).toMatchObject({ status: 'paused', summary: 'On hold', title: 'Plan Tokyo trip' });
      await events.waitFor((e) => e.data.type === 'goal.updated' && e.data.goal.status === 'paused');
      expect((await alice.api('GET', '/v1/goals?status=active')).body.items).toEqual([]);
      expect((await alice.api('GET', '/v1/goals?status=paused')).body.items).toHaveLength(1);

      const ideas = await alice.api('GET', `/v1/ideas?agentId=${agent.body.id}&status=open`);
      expect(ideas.body.items).toHaveLength(2);
      const hotels = ideas.body.items.find((idea: { text: string }) => idea.text === 'Want me to compare hotels?');
      const packing = ideas.body.items.find((idea: { text: string }) => idea.text === 'Want a packing list?');
      const accepted = await alice.api('POST', `/v1/ideas/${hotels.id}/accept`);
      expect(accepted.body).toMatchObject({ status: 'accepted', prompt: 'Compare hotels in Shinjuku' });
      expect((await alice.api('POST', `/v1/ideas/${packing.id}/dismiss`)).body).toMatchObject({ status: 'dismissed' });
      expect((await alice.api('GET', '/v1/ideas?status=open')).body.items).toEqual([]);
      await events.waitFor((e) => e.data.type === 'idea.updated' && e.data.idea.id === packing.id && e.data.idea.status === 'dismissed');

      // Another account sees none of it and cannot touch it.
      expect((await bob.api('GET', '/v1/goals')).body.items).toEqual([]);
      expect((await bob.api('GET', '/v1/ideas')).body.items).toEqual([]);
      expect((await bob.api('PATCH', `/v1/goals/${goal.id}`, { title: 'hijacked' })).status).toBe(404);
      expect((await bob.api('DELETE', `/v1/goals/${goal.id}`)).status).toBe(404);
      expect((await bob.api('POST', `/v1/ideas/${hotels.id}/dismiss`)).status).toBe(404);

      expect((await alice.api('DELETE', `/v1/goals/${goal.id}`)).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'goal.deleted' && e.data.goalId === goal.id);
      expect((await alice.api('GET', '/v1/goals')).body.items).toEqual([]);
    } finally {
      events.close();
    }
  });
});
