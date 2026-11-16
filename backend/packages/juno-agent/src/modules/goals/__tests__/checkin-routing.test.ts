/** Where proactive messages go: the goal's check-in, and the agent the background jobs act as, with a Feishu chat on the oldest agent. */
import { describe, expect, it } from 'vitest';
import type { Goal } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import { jobAgent } from '../../memory/jobs/agent.js';
import { buildGoalWake } from '../checkin.js';

const OWNER = 'owner';
const NOW = new Date('2026-10-23T09:00:00Z');

async function seed() {
  const store = createMemoryStore();
  await store.put('agents', { id: 'agt-test', name: 'Test', title: 'Tester', ownerId: OWNER, createdAt: '2025-12-01T00:00:00Z' } as never);
  await store.put('agents', { id: 'agt-life', name: 'Personal Life', title: 'Life', ownerId: OWNER, createdAt: '2026-02-01T00:00:00Z' } as never);
  const chat = (id: string, agent: string, lastItemAt: string, channel?: { kind: string; channelId: string }) =>
    store.put('conversations', { id, kind: 'direct', agentIds: [agent], memberIds: [OWNER], ownerId: OWNER, ...(channel === undefined ? {} : { channel }), unreadCount: 0, lastItemAt, createdAt: '2026-10-01T00:00:00Z' } as never);
  await chat('c-feishu', 'agt-test', '2026-10-22T00:00:00Z', { kind: 'feishu', channelId: 'ch-1' });
  await chat('c-test-app', 'agt-test', '2026-10-01T00:00:00Z');
  await chat('c-life-old', 'agt-life', '2026-10-05T00:00:00Z');
  await chat('c-life', 'agt-life', '2026-10-20T00:00:00Z');
  return store;
}

const goal = (over: Partial<Goal> = {}): Goal & { ownerId: string } => ({
  id: 'goal-1', ownerId: OWNER, agentId: 'agt-life', kind: 'goal', title: 'Get LANY tickets', summary: '', status: 'active', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...over,
});

describe('goal check-in routing', () => {
  it('posts a check-in in the chat the goal was made in, even when it is not the newest chat of that agent', async () => {
    const store = await seed();
    const wake = await buildGoalWake(store, goal({ conversationId: 'c-life-old' }), 'scheduled', NOW, 'k');
    expect(wake).toMatchObject({ agentId: 'agt-life', conversationId: 'c-life-old' });
  });

  it('falls back to the newest in-app chat of the agent when the goal records none or records a chat the agent is not in, and never to a platform chat while an app chat exists', async () => {
    const store = await seed();
    expect((await buildGoalWake(store, goal(), 'scheduled', NOW, 'k'))?.conversationId).toBe('c-life');
    expect((await buildGoalWake(store, goal({ conversationId: 'c-feishu' }), 'scheduled', NOW, 'k'))?.conversationId).toBe('c-life');
    // The Test agent has a newer Feishu chat than its app chat: the app chat still wins.
    expect((await buildGoalWake(store, goal({ agentId: 'agt-test' }), 'scheduled', NOW, 'k'))?.conversationId).toBe('c-test-app');
  });
});

describe('the agent the background jobs act as', () => {
  it('is the default agent when it is set, else the agent with the newest in-app chat, never the oldest agent just because it was created first', async () => {
    const store = await seed();
    const log: string[] = [];
    expect((await jobAgent(store, OWNER, (_f, message) => log.push(message)))?.agent.id).toBe('agt-life');
    expect(log).toEqual(['job agent picked by the most recent in-app chat']);
    await store.put('settings', { id: 'app-settings-' + OWNER, ownerId: OWNER, general: { defaultAgentId: 'agt-test' } } as never);
    expect((await jobAgent(store, OWNER))?.agent.id).toBe('agt-test');
  });
});
