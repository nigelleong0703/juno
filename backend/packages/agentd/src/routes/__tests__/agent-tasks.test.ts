/**
 * GET /v1/agents/:id/plans (GC12; `tasks` before 0.3). The endpoint serves the authoritative latest plan per
 * conversation for one agent, includes done entries, and is owner-scoped: a foreign or unknown agent
 * behaves exactly like a missing id, so one owner can never read another owner's tasks.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { Agent, Conversation, PlanItem, Todo } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders } from '../../__tests__/test-app.js';
import { canonicalPlanId } from 'juno-agent/modules/tasks/state';

const A = 'owner-alice';
const B = 'owner-bob';
const NOW = '2026-10-08T00:00:00.000Z';

/** Production's service identity: `a` and `b` are owners A and B; any other token is unauthenticated (401). */
function tokenHeaders(token: string): Record<string, string> {
  return token === 'a' ? ownerHeaders(A) : token === 'b' ? ownerHeaders(B) : {};
}

async function makeApp(): Promise<{ app: ReturnType<typeof createTestApp>; store: Store }> {
  const mem = createMemoryStore();
  const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() });
  return { app, store: mem };
}

function ownerStore(store: Store, owner: string): Store {
  const scoped = store.forOwner?.(owner);
  if (!scoped) throw new Error('test store is missing forOwner');
  return scoped;
}

function agentDoc(id: string): Agent {
  return {
    id,
    name: id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'Test agent',
    status: 'idle',
    section: 'Agents',
    pinned: false,
    lastActivity: NOW,
    unreadCount: 0,
    model: {
      planner: { provider: 'anthropic', model: 'claude-opus' },
      computer: { provider: 'anthropic', model: 'claude-opus' },
      fast: { provider: 'anthropic', model: 'claude-haiku' },
    },
    channels: [{ kind: 'chat', status: 'connected' }],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function conversationDoc(id: string, agentIds: string[]): Conversation {
  return {
    id,
    kind: 'direct',
    agentIds,
    memberIds: ['user-1'],
    unreadCount: 0,
    lastItemAt: NOW,
    createdAt: NOW,
  };
}

function planDoc(agentId: string, conversationId: string, runId: string, todos: Todo[]): PlanItem {
  return {
    id: canonicalPlanId(agentId, conversationId),
    conversationId,
    agentId,
    type: 'plan',
    runId,
    todos,
    at: NOW,
  };
}

function plans(app: ReturnType<typeof createTestApp>, token: string, agentId: string): Promise<Response> {
  return Promise.resolve(
    app.request('/v1/agents/' + agentId + '/plans', { headers: { ...tokenHeaders(token) } }),
  );
}

async function seedOwner(store: Store, owner: string, agentId: string, conversationId: string): Promise<void> {
  const scoped = ownerStore(store, owner);
  await scoped.put('agents', agentDoc(agentId));
  await scoped.put('conversations', conversationDoc(conversationId, [agentId]));
  await scoped.put(
    'items',
    planDoc(agentId, conversationId, 'run-' + agentId, [
      { id: 'p1', text: 'Outstanding', status: 'pending' },
      { id: 'd1', text: 'Finished', status: 'done' },
    ]),
    { conversationId, runId: 'run-' + agentId, agentId },
  );
}

describe('GET /v1/agents/:id/plans', () => {
  it('returns the authoritative plan with done entries and no cursor', async () => {
    const { app, store } = await makeApp();
    await seedOwner(store, A, 'agent-a', 'conv-a');
    await seedOwner(store, A, 'agent-a2', 'conv-a2');

    const res = await plans(app, 'a', 'agent-a');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { items: PlanItem[]; nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item) => item.id)).toEqual([canonicalPlanId('agent-a', 'conv-a')]);
    expect(body.items[0]?.todos.map((todo) => todo.status)).toEqual(['pending', 'done']);
    expect(body.items[0]?.agentId).toBe('agent-a');
  });

  it('hides a foreign owner and an unknown agent behind 404', async () => {
    const { app, store } = await makeApp();
    await seedOwner(store, A, 'agent-a', 'conv-a');
    await seedOwner(store, B, 'agent-b', 'conv-b');

    expect((await plans(app, 'b', 'agent-a')).status).toBe(404);
    expect((await plans(app, 'a', 'agent-b')).status).toBe(404);
    expect((await plans(app, 'a', 'agent-missing')).status).toBe(404);
  });
});
