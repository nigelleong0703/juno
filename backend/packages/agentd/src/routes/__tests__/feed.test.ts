/**
 * Feedback on feed posts and the Today header on the production app assembly: the owner's "more / less" with reason and note,
 * owner isolation, and the brief made of today's posts that routine runs published.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { FeedPost, Today } from '@agent-desktop/public-contracts';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const OWNER = 'owner-a';
const OTHER = 'owner-b';
const NOW = new Date().toISOString();

const enqueuer = { async enqueue() { return { accepted: true }; }, async stopRun() {}, async resolveAwakeable() {}, async scheduleRoutine() {} } as never;

describe('feed feedback', () => {
  let store: Store;
  let app: Hono;
  const as = (owner: string, path: string, init: { method?: string; body?: unknown } = {}) => requestAs(app, owner, path, init);
  const post = (id: string, extra: Partial<FeedPost> = {}) => store.put('feedPosts', { id, agentId: 'agt-1', title: id, summary: 's', liked: false, createdAt: NOW, updatedAt: NOW, ...extra } as never);

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    await post('p1');
    await post('p2');
  });

  it('records more / less with a reason and a note, replacing the last feedback whole', async () => {
    expect((await as(OWNER, '/v1/feed/p2/feedback', { method: 'POST', body: { signal: 'less' } })).status).toBe(200);
    expect((await store.get('feedPosts', 'p2'))?.feedback).toBe('less');
    const rich = await as(OWNER, '/v1/feed/p1/feedback', { method: 'POST', body: { signal: 'less', reason: 'source', note: '  too spammy  ' } });
    expect(rich.status).toBe(200);
    expect(await rich.json()).toMatchObject({ feedback: 'less', feedbackReason: 'source', feedbackNote: 'too spammy' });
    const again = (await (await as(OWNER, '/v1/feed/p1/feedback', { method: 'POST', body: { signal: 'more' } })).json()) as FeedPost;
    expect(again.feedback).toBe('more');
    expect(again.feedbackReason).toBeUndefined();
    expect(again.feedbackNote).toBeUndefined();
  });

  it('refuses a bad signal, reason or note, and another owner\'s post', async () => {
    for (const body of [{ signal: 'maybe' }, { signal: 'less', reason: 'boring' }, { signal: 'less', reason: 'other', note: 'x'.repeat(201) }]) {
      expect((await as(OWNER, '/v1/feed/p1/feedback', { method: 'POST', body })).status).toBe(400);
    }
    expect((await as(OTHER, '/v1/feed/p1/feedback', { method: 'POST', body: { signal: 'less' } })).status).toBe(404);
    expect((await store.get('feedPosts', 'p1'))?.feedback).toBeUndefined();
  });
});

describe('GET /v1/today', () => {
  it('composes what needs the owner, what is running and today\'s routine posts', async () => {
    const mem = createMemoryStore();
    const store = withDefaultOwner(mem, OWNER);
    const app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    const base = { agentId: 'agt-1', createdAt: NOW };
    const request = (id: string, title: string, status = 'pending') => store.put('requests', { id, kind: 'approval', status, title, summary: '', payload: { kind: 'approval' }, ...base } as never);
    await request('r1', 'Send the invoice');
    await request('r2', 'Book the flight');
    await request('r3', 'Old one', 'approved');
    await store.put('requests', { id: 'r-foreign', kind: 'approval', status: 'pending', title: 'Not mine', summary: '', payload: { kind: 'approval' }, ...base, ownerId: OTHER } as never);
    await store.put('runs', { id: 'run-1', agentId: 'agt-1', title: 'Researching flights', status: 'running', kind: 'chat', steps: [], startedAt: NOW } as never);
    await store.put('runs', { id: 'run-child', agentId: 'agt-1', parentRunId: 'run-1', title: 'child', status: 'running', kind: 'chat', steps: [], startedAt: NOW } as never);
    await store.put('runs', { id: 'run-routine', agentId: 'agt-1', routineId: 'rtn-news', title: 'Routine: news', status: 'completed', kind: 'routine', steps: [], startedAt: NOW, finishedAt: NOW } as never);
    const post = (id: string, title: string, createdAt: string, routineId?: string) => store.put('feedPosts', { id, agentId: 'agt-1', title, summary: 's', liked: false, createdAt, updatedAt: createdAt, ...(routineId === undefined ? {} : { routineId }) } as never);
    await post('n1', 'AI digest', new Date(Date.now() - 2000).toISOString(), 'rtn-news');
    await post('n2', 'Your Thursday', NOW, 'rtn-brief');
    await post('own', 'Posted from chat', NOW);
    await post('old', 'Last year', '2020-01-01T00:00:00.000Z', 'rtn-news');

    const today = (await (await requestAs(app, OWNER, '/v1/today')).json()) as Today;
    expect(today.now.timezone).toBe('UTC');
    expect(today.needsYou.count).toBe(2);
    expect(today.working).toEqual([{ agentId: 'agt-1', runId: 'run-1', title: 'Researching flights' }]);
    expect(today.brief).toMatchObject({ routineId: 'rtn-brief', summary: 'Your Thursday · 1 more' });
    expect(today.brief?.postIds.sort()).toEqual(['n1', 'n2']);
    expect(today.completed).toEqual([]);

    const empty = (await (await requestAs(app, OTHER, '/v1/today')).json()) as Today;
    expect(empty.brief).toBeUndefined();
    expect(empty.needsYou.count).toBe(1);
  });
});
