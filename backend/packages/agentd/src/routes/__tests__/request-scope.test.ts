/**
 * Request dependency facade (AU2), retargeted to an agent-owned collection now that library moved
 * to the public API: two owners sharing one app must each see only their own routines, a foreign
 * direct id behaves exactly like a missing id, and a write to a foreign id is refused. Without a
 * request owner the production service refuses the request (401): it never falls back to every owner's rows.
 * The second block proves the app-owned handlers left the private service entirely.
 */
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { Agent, FeedPost, Goal, Routine } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, TEST_INTERNAL_TOKEN } from '../../__tests__/test-app.js';

const A = 'owner-a';
const B = 'owner-b';

function routine(id: string, owner: string): Routine & { ownerId: string } {
  return {
    id,
    agentId: 'agent-' + owner,
    name: id,
    instructions: '',
    trigger: { kind: 'schedule', human: 'Daily', tz: 'UTC' },
    delivery: { channel: 'chat' },
    notify: { mode: 'always' },
    enabled: true,
    status: 'active',
    runs: [],
    createdAt: new Date().toISOString(),
    ownerId: owner,
  };
}

function ownerStore(store: Store, owner: string): Store {
  const scoped = store.forOwner?.(owner);
  if (!scoped) throw new Error('test store is missing forOwner');
  return scoped;
}

async function makeApp(): Promise<{ app: Hono; store: Store }> {
  const mem = createMemoryStore();
  await ownerStore(mem, A).put('routines', routine('rt-a', A));
  await ownerStore(mem, B).put('routines', routine('rt-b', B));
  const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() });
  return { app, store: mem };
}

/** As `owner`; without one, the service token alone (no x-owner-id), which production refuses. */
function get(app: Hono, path: string, owner?: string): Promise<Response> {
  const headers = owner === undefined ? { authorization: `Bearer ${TEST_INTERNAL_TOKEN}` } : ownerHeaders(owner);
  return Promise.resolve(app.request(path, { headers }));
}

async function idsOf(res: Response): Promise<string[]> {
  const body = (await res.json()) as { items: { id: string }[] };
  return body.items.map((entry) => entry.id);
}

describe('request dependency facade', () => {
  it('lists only the request owner rows on a raw route', async () => {
    const { app } = await makeApp();
    await expect(idsOf(await get(app, '/v1/routines', A))).resolves.toEqual(['rt-a']);
    await expect(idsOf(await get(app, '/v1/routines', B))).resolves.toEqual(['rt-b']);
  });

  it('serves a foreign direct id exactly like a missing id', async () => {
    const { app } = await makeApp();
    const foreign = await get(app, '/v1/routines/rt-b', A);
    const missing = await get(app, '/v1/routines/rt-ghost', A);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.status).toBe(404);
    expect((await get(app, '/v1/routines/rt-a', A)).status).toBe(200);
  });

  it('fences writes on a raw route for foreign ids', async () => {
    const { app, store } = await makeApp();
    const init = (owner: string): RequestInit => ({ method: 'PATCH', headers: ownerHeaders(owner, true), body: JSON.stringify({ name: 'hacked' }) });
    const foreign = await app.request('/v1/routines/rt-a', init(B));
    const missing = await app.request('/v1/routines/rt-ghost', init(B));
    expect(foreign.status).toBe(missing.status);
    expect(foreign.status).toBe(404);
    expect((await ownerStore(store, A).get('routines', 'rt-a'))?.name).toBe('rt-a');
    const own = await app.request('/v1/routines/rt-a', init(A));
    expect(own.status).toBe(200);
    expect((await ownerStore(store, A).get('routines', 'rt-a'))?.name).toBe('hacked');
  });

  it('refuses a request without an owner instead of serving every owner\'s rows', async () => {
    const { app } = await makeApp();
    expect((await get(app, '/v1/routines')).status).toBe(401);
  });
});

it('fences role-suggestion writes to the agent owner', async () => {
  const { app, store } = await makeApp();
  const now = new Date().toISOString();
  const agent = {
    id: 'agt-a', name: 'Coach', handle: 'coach', avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'New agent', status: 'idle', section: 'Inbox', pinned: false, lastActivity: '', unreadCount: 0,
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: now, updatedAt: now,
    roleSuggestion: { title: 'Running coach', description: 'Tracks runs.', createdAt: now },
  };
  await ownerStore(store, A).put('agents', agent as never);
  for (const action of ['accept', 'dismiss']) {
    const res = await app.request('/v1/agents/agt-a/role-suggestion/' + action, { method: 'POST', headers: ownerHeaders(B) });
    expect(res.status, action).toBe(404);
  }
  const unchanged = await ownerStore(store, A).get('agents', 'agt-a');
  expect(unchanged?.title).toBe('New agent');
  expect(unchanged?.roleSuggestion?.title).toBe('Running coach');
});

describe('owner-scoped goals and feed', () => {
  const AT = '2026-10-11T09:00:00.000Z';
  const goalDoc = (id: string, owner: string, agentId: string): Goal & { ownerId: string } => ({
    id, agentId, kind: 'goal', title: id, summary: '', status: 'active', createdAt: AT, updatedAt: AT, ownerId: owner,
  });
  const postDoc = (id: string, owner: string, agentId: string): FeedPost & { ownerId: string } => ({
    id, agentId, title: id, summary: 'summary', liked: false, createdAt: AT, updatedAt: AT, ownerId: owner,
  });


  async function makeFeedApp(): Promise<{ app: Hono; store: Store }> {
    const mem = createMemoryStore();
    await ownerStore(mem, A).put('agents', { id: 'agent-a', name: 'Agent A' } as Agent);
    await ownerStore(mem, A).put('goals', goalDoc('goal-a', A, 'agent-a'));
    await ownerStore(mem, B).put('goals', goalDoc('goal-b', B, 'agent-b'));
    await ownerStore(mem, A).put('feedPosts', postDoc('feed-a', A, 'agent-a'));
    await ownerStore(mem, B).put('feedPosts', postDoc('feed-b', B, 'agent-b'));
    const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() });
    return { app, store: mem };
  }

  function send(app: Hono, method: string, path: string, owner: string, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: ownerHeaders(owner, true),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    return Promise.resolve(app.request(path, init));
  }

  it('reads an old feed row leniently: a short body becomes the summary, a long one is clipped', async () => {
    const { app, store } = await makeFeedApp();
    const long = 'word '.repeat(80).trim();
    const { summary: _summary, ...legacy } = postDoc('feed-long', A, 'agent-a');
    // @ts-expect-error a row written before `summary` existed
    await ownerStore(store, A).put('feedPosts', { ...legacy, body: long });
    const { summary: _s2, ...legacyShort } = postDoc('feed-short', A, 'agent-a');
    // @ts-expect-error a row written before `summary` existed
    await ownerStore(store, A).put('feedPosts', { ...legacyShort, body: 'short old body' });
    const items = (await (await send(app, 'GET', '/v1/feed', A)).json() as { items: FeedPost[] }).items;
    expect(items.find((p) => p.id === 'feed-short')).toMatchObject({ summary: 'short old body' });
    const clipped = items.find((p) => p.id === 'feed-long');
    expect(clipped?.body).toBe(long);
    expect(clipped?.summary.length).toBeLessThanOrEqual(240);
  });

  it('lists only the owner goals and feed posts', async () => {
    const { app } = await makeFeedApp();
    await expect(idsOf(await send(app, 'GET', '/v1/goals', A))).resolves.toEqual(['goal-a']);
    await expect(idsOf(await send(app, 'GET', '/v1/goals', B))).resolves.toEqual(['goal-b']);
    await expect(idsOf(await send(app, 'GET', '/v1/feed', A))).resolves.toEqual(['feed-a']);
    await expect(idsOf(await send(app, 'GET', '/v1/feed', B))).resolves.toEqual(['feed-b']);
    await expect(idsOf(await send(app, 'GET', '/v1/feed?agentId=agent-b', A))).resolves.toEqual([]);
  });

  it('fetches a goal with its activity, and answers a foreign goal like a missing one', async () => {
    const { app } = await makeFeedApp();
    const own = await send(app, 'GET', '/v1/goals/goal-a', A);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { activity: unknown[] }).activity).toEqual([]);
    const foreign = await send(app, 'GET', '/v1/goals/goal-b', A);
    const missing = await send(app, 'GET', '/v1/goals/goal-ghost', A);
    expect(foreign.status).toBe(404);
    expect(foreign.status).toBe(missing.status);
  });

  it('fences a foreign goal write and leaves the row unchanged', async () => {
    const { app, store } = await makeFeedApp();
    const foreign = await send(app, 'PATCH', '/v1/goals/goal-b', A, { title: 'hacked' });
    expect(foreign.status).toBe(404);
    expect((await ownerStore(store, B).get('goals', 'goal-b'))?.title).toBe('goal-b');
  });

  it('creates a goal only for an agent the caller owns, and records the creation', async () => {
    const { app, store } = await makeFeedApp();
    const refused = await send(app, 'POST', '/v1/goals', B, { agentId: 'agent-a', kind: 'goal', title: 'x' });
    expect(refused.status).toBe(404);
    const created = await send(app, 'POST', '/v1/goals', A, { agentId: 'agent-a', kind: 'goal', title: 'Save 1k', category: 'finance' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Goal;
    expect(body).toMatchObject({ agentId: 'agent-a', category: 'finance', status: 'active' });
    expect(body.activity?.[0]).toMatchObject({ actor: 'user', kind: 'created', text: 'Save 1k' });
    expect((await ownerStore(store, B).list('goals')).items.map((g) => g.id)).toEqual(['goal-b']);
  });

  it('appends a timeline entry on each user edit', async () => {
    const { app } = await makeFeedApp();
    await send(app, 'PATCH', '/v1/goals/goal-a', A, { status: 'done' });
    const row = (await (await send(app, 'GET', '/v1/goals/goal-a', A)).json()) as Goal;
    expect(row.activity?.[0]).toMatchObject({ actor: 'user', kind: 'status', text: 'status: done' });
  });

  it('likes only the owner post; a foreign post answers like a missing one', async () => {
    const { app, store } = await makeFeedApp();
    expect((await send(app, 'POST', '/v1/feed/feed-b/like', A, { liked: true })).status).toBe(404);
    expect((await send(app, 'POST', '/v1/feed/feed-ghost/like', A, { liked: true })).status).toBe(404);
    expect((await ownerStore(store, B).get('feedPosts', 'feed-b'))?.liked).toBe(false);
    const own = await send(app, 'POST', '/v1/feed/feed-a/like', A, { liked: true });
    expect(own.status).toBe(200);
    expect(((await own.json()) as FeedPost).liked).toBe(true);
  });
});
