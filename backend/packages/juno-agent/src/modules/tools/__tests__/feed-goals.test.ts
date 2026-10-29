/** feed_post publishes into the owner's feed; goal writes (agent and user) leave a timeline entry. */
import { describe, expect, it } from 'vitest';
import type { Store, Tool, ToolContext } from '../../../contracts/index.js';
import type { Goal } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import { toolContext } from '../../../execution/brain/__tests__/agent-resources.fixtures.js';
import { createFeedPostTool } from '../tools/feedPost.js';
import type { ChildRun } from '../../tasks/childRead.js';
import { putRunPreservingChild } from '../../../execution/harness/services/run-reservation.js';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import { createChildSpawnTool } from '../../tasks/childTools.js';
import type { SafeFetchDeps } from '../net/safeFetch.js';
import { fakeWeb, jpeg } from '../../feed/__tests__/image-fixtures.js';
import { createGoalUpdateTool } from '../tools/goalTools.js';

const ownerStore = (): Store => {
  const forOwner = createMemoryStore().forOwner;
  if (forOwner === undefined) throw new Error('test store lacks forOwner');
  return forOwner('owner-1');
};

async function call(tool: Tool, ctx: ToolContext, args: unknown): Promise<{ text: string; isError: boolean }> {
  const result = await tool.execute(args, ctx);
  const part = result.content[0];
  return { text: part?.type === 'text' ? part.text : '', isError: result.isError === true };
}

function routineCtx(store: Store, routineId: string): ToolContext {
  const base = toolContext(store, 'agent-a');
  return { ...base, wake: { ...base.wake, kind: 'routine', origin: { type: 'automation' }, payload: { routineId } } };
}

describe('feed_post', () => {
  it('publishes an owner-scoped, unliked post and emits feed.created', async () => {
    const store = ownerStore();
    const ctx = toolContext(store, 'agent-a');
    const result = await call(createFeedPostTool(), ctx, { title: ' Rate cut ', summary: 'The bank cut rates.', sourceUrl: 'https://example.com/a' });
    expect(result.isError).toBe(false);
    const rows = (await store.list('feedPosts')).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: 'agent-a', title: 'Rate cut', liked: false, sourceUrl: 'https://example.com/a' });
    expect(rows[0]?.imageUrl).toBeUndefined();
  });

  it('enforces the summary length and display-only ui', async () => {
    const store = ownerStore();
    const ctx = toolContext(store, 'agent-a');
    const long = await call(createFeedPostTool(), ctx, { title: 't', summary: 'x'.repeat(241) });
    expect(long).toMatchObject({ isError: true });
    expect(long.text).toMatch(/two sentences/);
    const choices = { version: 1, blocks: [{ type: 'choices', id: 'c', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] };
    expect((await call(createFeedPostTool(), ctx, { title: 't', summary: 's', ui: choices })).isError).toBe(true);
    const facts = { version: 1, blocks: [{ type: 'facts', rows: [{ label: 'Date', value: 'Oct 15' }] }] };
    expect((await call(createFeedPostTool(), ctx, { title: 't', summary: 's', ui: facts })).isError).toBe(false);
    expect((await store.list('feedPosts')).items).toHaveLength(1);
  });

  it('refuses a post without a title or summary', async () => {
    const store = ownerStore();
    expect((await call(createFeedPostTool(), toolContext(store, 'agent-a'), { title: 'x' })).isError).toBe(true);
    expect((await store.list('feedPosts')).items).toHaveLength(0);
  });
});

describe('feed_post chat card', () => {
  it('adds a feed_ref card to the chat when the user started the run', async () => {
    const store = ownerStore();
    const res = await call(createFeedPostTool({ deps: fakeWeb({}, { 'https://i.example/a.png': jpeg(1200, 630) }) }), toolContext(store, 'agent-a'), { title: 'T', summary: 'B', imageUrl: 'https://i.example/a.png', imageCaption: 'c' });
    expect(res.text).toMatch(/card linking to it was added to this chat/);
    const post = (await store.list('feedPosts')).items[0];
    const items = (await store.list('items', { where: { conversationId: 'conv-1' } })).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'feed_ref', feedPostId: post?.id, title: 'T', imageUrl: 'https://i.example/a.png', agentId: 'agent-a' });
  });

  it('adds a feed_ref card when a user-requested notify child completes and the task_done parent publishes', async () => {
    const store = ownerStore();
    const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };
    const parent: ChildRun = { id: 'run-parent', agentId: 'agent-a', conversationId: 'conv-1', title: 'Research AI news illustrated article', status: 'completed', kind: 'chat', steps: [], usage, startedAt: '2026-10-27T04:18:55.000Z', lastActivityAt: '2026-10-27T04:18:55.000Z' };
    const child: ChildRun = { id: 'run-child-1', agentId: 'agent-a', conversationId: 'conv-1', title: 'Research AI news illustrated article', status: 'completed', kind: 'background', parentRunId: 'run-parent', notifyParent: { ownerId: 'owner-1', agentId: 'agent-a', conversationId: 'conv-1', chainId: 'run-parent', generation: 1 }, feedCardUserOrigin: true, steps: [], usage, startedAt: '2026-10-27T04:19:00.000Z', lastActivityAt: '2026-10-27T04:20:00.000Z' };
    const wrapping: ChildRun = { id: 'run-1', agentId: 'agent-a', conversationId: 'conv-1', title: 'Wrapping up: Research AI news illustrated article', status: 'running', kind: 'background', steps: [], usage, startedAt: '2026-10-27T04:21:00.000Z', lastActivityAt: '2026-10-27T04:21:00.000Z' };
    await store.put('runs', parent, { conversationId: 'conv-1' });
    await store.put('runs', child, { conversationId: 'conv-1' });
    await store.put('runs', wrapping, { conversationId: 'conv-1' });
    const base = toolContext(store, 'agent-a');
    const wake = { ...base.wake, id: 'run-child-1:done', kind: 'task_done' as const, origin: { type: 'system' as const }, trusted: false, priority: 'background' as const, payload: { taskId: 'run-child-1', taskKind: 'child', status: 'completed', summary: 'research done', originRunId: 'run-parent', generation: 1 } };
    const res = await call(createFeedPostTool(), { ...base, wake }, { title: 'T', summary: 'B' });
    expect(res.text).toMatch(/card linking to it was added to this chat/);
    const post = (await store.list('feedPosts')).items[0];
    const items = (await store.list('items', { where: { conversationId: 'conv-1' } })).items.filter((item) => item.type === 'feed_ref');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'feed_ref', feedPostId: post?.id, agentId: 'agent-a' });
  });

  it('stays silent when the stamped link is missing: no flag, a lying originRunId, or a non-child task', async () => {
    const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };
    const seed = async (child: ChildRun): Promise<Store> => {
      const store = ownerStore();
      const parent: ChildRun = { id: 'run-parent', agentId: 'agent-a', conversationId: 'conv-1', title: 'P', status: 'completed', kind: 'chat', steps: [], usage, startedAt: '2026-10-27T04:18:55.000Z', lastActivityAt: '2026-10-27T04:18:55.000Z' };
      const wrapping: ChildRun = { id: 'run-1', agentId: 'agent-a', conversationId: 'conv-1', title: 'Wrapping up: P', status: 'running', kind: 'background', steps: [], usage, startedAt: '2026-10-27T04:21:00.000Z', lastActivityAt: '2026-10-27T04:21:00.000Z' };
      await store.put('runs', parent, { conversationId: 'conv-1' });
      await store.put('runs', child, { conversationId: 'conv-1' });
      await store.put('runs', wrapping, { conversationId: 'conv-1' });
      return store;
    };
    const noFlag: ChildRun = { id: 'run-child-1', agentId: 'agent-a', conversationId: 'conv-1', title: 'P', status: 'completed', kind: 'background', parentRunId: 'run-parent', notifyParent: { ownerId: 'owner-1', agentId: 'agent-a', conversationId: 'conv-1', chainId: 'run-parent', generation: 1 }, steps: [], usage, startedAt: '2026-10-27T04:19:00.000Z', lastActivityAt: '2026-10-27T04:20:00.000Z' };
    const stamped: ChildRun = { ...noFlag, feedCardUserOrigin: true };
    const taskDoneFor = (store: Store, payload: Record<string, unknown>): ToolContext => {
      const base = toolContext(store, 'agent-a');
      return { ...base, wake: { ...base.wake, id: 'run-child-1:done', kind: 'task_done', origin: { type: 'system' }, trusted: false, priority: 'background', payload } };
    };
    const missing = await seed(noFlag);
    const missingRes = await call(createFeedPostTool(), taskDoneFor(missing, { taskId: 'run-child-1', taskKind: 'child', status: 'completed', summary: 'done', originRunId: 'run-parent', generation: 1 }), { title: 'T', summary: 'B' });
    expect(missingRes.text).toMatch(/Nothing was added to the chat/);
    const lying = await seed(stamped);
    const lyingRes = await call(createFeedPostTool(), taskDoneFor(lying, { taskId: 'run-child-1', taskKind: 'child', status: 'completed', summary: 'done', originRunId: 'run-other', generation: 1 }), { title: 'T', summary: 'B' });
    expect(lyingRes.text).toMatch(/Nothing was added to the chat/);
    const shell = await seed(stamped);
    const shellRes = await call(createFeedPostTool(), taskDoneFor(shell, { taskId: 'shell-1', taskKind: 'shell', status: 'completed', summary: 'done', originRunId: 'run-parent', generation: 1 }), { title: 'T', summary: 'B' });
    expect(shellRes.text).toMatch(/Nothing was added to the chat/);
    for (const store of [missing, lying, shell]) {
      expect((await store.list('items', { where: { conversationId: 'conv-1' } })).items).toHaveLength(0);
    }
  });

  it('keeps the private origin stamp across a run-row rebuild', async () => {
    const store = ownerStore();
    const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };
    const child: ChildRun = { id: 'run-child-1', agentId: 'agent-a', conversationId: 'conv-1', title: 'P', status: 'completed', kind: 'background', parentRunId: 'run-parent', notifyParent: { ownerId: 'owner-1', agentId: 'agent-a', conversationId: 'conv-1', chainId: 'run-parent', generation: 1 }, feedCardUserOrigin: true, steps: [], usage, startedAt: '2026-10-27T04:19:00.000Z', lastActivityAt: '2026-10-27T04:20:00.000Z' };
    await store.put('runs', child, { conversationId: 'conv-1' });
    const { feedCardUserOrigin: _dropped, ...fresh } = child;
    const rebuilt: ChildRun = await putRunPreservingChild(store, fresh, true);
    expect(rebuilt.feedCardUserOrigin).toBe(true);
  });

  it('stays silent across conversations and when the publisher is itself a child run', async () => {
    const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };
    const parent: ChildRun = { id: 'run-parent', agentId: 'agent-a', conversationId: 'conv-1', title: 'P', status: 'completed', kind: 'chat', steps: [], usage, startedAt: '2026-10-27T04:18:55.000Z', lastActivityAt: '2026-10-27T04:18:55.000Z' };
    const child: ChildRun = { id: 'run-child-1', agentId: 'agent-a', conversationId: 'conv-1', title: 'P', status: 'completed', kind: 'background', parentRunId: 'run-parent', notifyParent: { ownerId: 'owner-1', agentId: 'agent-a', conversationId: 'conv-1', chainId: 'run-parent', generation: 1 }, feedCardUserOrigin: true, steps: [], usage, startedAt: '2026-10-27T04:19:00.000Z', lastActivityAt: '2026-10-27T04:20:00.000Z' };
    const payload = { taskId: 'run-child-1', taskKind: 'child', status: 'completed', summary: 'done', originRunId: 'run-parent', generation: 1 };
    const foreign = ownerStore();
    const foreignWrapping: ChildRun = { id: 'run-1', agentId: 'agent-a', conversationId: 'conv-2', title: 'Wrapping up: P', status: 'running', kind: 'background', steps: [], usage, startedAt: '2026-10-27T04:21:00.000Z', lastActivityAt: '2026-10-27T04:21:00.000Z' };
    await foreign.put('runs', parent, { conversationId: 'conv-1' });
    await foreign.put('runs', child, { conversationId: 'conv-1' });
    await foreign.put('runs', foreignWrapping, { conversationId: 'conv-2' });
    const foreignBase = { ...toolContext(foreign, 'agent-a'), conversationId: 'conv-2' };
    const foreignRes = await call(createFeedPostTool(), { ...foreignBase, wake: { ...foreignBase.wake, id: 'run-child-1:done', kind: 'task_done', origin: { type: 'system' }, trusted: false, priority: 'background', payload } }, { title: 'T', summary: 'B' });
    expect(foreignRes.text).toMatch(/Nothing was added to the chat/);
    const store = ownerStore();
    const publishingChild: ChildRun = { id: 'run-1', agentId: 'agent-a', conversationId: 'conv-1', title: 'Wrapping up: P', status: 'running', kind: 'background', parentRunId: 'run-parent', steps: [], usage, startedAt: '2026-10-27T04:21:00.000Z', lastActivityAt: '2026-10-27T04:21:00.000Z' };
    await store.put('runs', parent, { conversationId: 'conv-1' });
    await store.put('runs', child, { conversationId: 'conv-1' });
    await store.put('runs', publishingChild, { conversationId: 'conv-1' });
    const base = toolContext(store, 'agent-a');
    const childPub = await call(createFeedPostTool(), { ...base, wake: { ...base.wake, id: 'run-child-1:done', kind: 'task_done', origin: { type: 'system' }, trusted: false, priority: 'background', payload } }, { title: 'T', summary: 'B' });
    expect(childPub.text).toMatch(/Nothing was added to the chat/);
  });

  it('stamps a spawned child exactly when the spawning run is card-eligible (same guard as publishing)', async () => {
    const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };
    const at = '2026-10-27T04:18:55.000Z';
    const seed = async (): Promise<Store> => {
      const store = ownerStore();
      const agent: Agent = { id: 'agent-a', name: 'A', handle: 'a', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: at, updatedAt: at };
      const conversation: Conversation = { id: 'conv-1', kind: 'direct', agentIds: ['agent-a'], memberIds: ['owner-1'], unreadCount: 0, lastItemAt: at, createdAt: at };
      const parent: ChildRun = { id: 'run-parent', agentId: 'agent-a', conversationId: 'conv-1', title: 'P', status: 'running', kind: 'chat', steps: [], usage, startedAt: at, lastActivityAt: at };
      await store.put('agents', agent);
      await store.put('conversations', conversation);
      await store.put('runs', parent, { conversationId: 'conv-1' });
      return store;
    };
    const userStore = await seed();
    const userSpawn = createChildSpawnTool({ store: userStore, adapter: { startChildRun: async () => {} } });
    const userCtx = { ...toolContext(userStore, 'agent-a'), runId: 'run-parent', stepId: 'stp-user' };
    const userRes = await userSpawn.execute({ prompt: 'research this' }, userCtx);
    expect(userRes.isError).not.toBe(true);
    const userChildId = String(Reflect.get(Reflect.get(userRes.details ?? {}, 'spawned') ?? {}, 'runId'));
    const userChild: ChildRun | null = await userStore.get('runs', userChildId);
    expect(userChild?.feedCardUserOrigin).toBe(true);
    const routineStore = await seed();
    const routineSpawn = createChildSpawnTool({ store: routineStore, adapter: { startChildRun: async () => {} } });
    const routineBase = toolContext(routineStore, 'agent-a');
    const routineCtx = { ...routineBase, runId: 'run-parent', stepId: 'stp-routine', wake: { ...routineBase.wake, kind: 'routine' as const, origin: { type: 'automation' as const }, payload: { routineId: 'rtn-1' } } };
    const routineRes = await routineSpawn.execute({ prompt: 'research this' }, routineCtx);
    expect(routineRes.isError).not.toBe(true);
    const routineChildId = String(Reflect.get(Reflect.get(routineRes.details ?? {}, 'spawned') ?? {}, 'runId'));
    const routineChild: ChildRun | null = await routineStore.get('runs', routineChildId);
    expect(routineChild?.feedCardUserOrigin).toBeUndefined();
  });

  it('adds nothing to the chat for routine, goal or self-initiated runs', async () => {
    for (const wake of [{ kind: 'routine' as const, origin: { type: 'automation' as const } }, { kind: 'goal_checkin' as const, origin: { type: 'system' as const } }, { kind: 'timer' as const, origin: { type: 'system' as const } }]) {
      const store = ownerStore();
      const base = toolContext(store, 'agent-a');
      const res = await call(createFeedPostTool(), { ...base, wake: { ...base.wake, ...wake } }, { title: 'T', summary: 'B' });
      expect(res.text).toMatch(/Nothing was added to the chat/);
      expect((await store.list('feedPosts')).items).toHaveLength(1);
      expect((await store.list('items', { where: { conversationId: 'conv-1' } })).items).toHaveLength(0);
    }
  });
});

describe('feed_post images', () => {
  const page = (head: string) => `<html><head>${head}</head><body></body></html>`;
  const post = async (args: unknown, deps: SafeFetchDeps) => {
    const store = ownerStore();
    const res = await call(createFeedPostTool({ deps }), toolContext(store, 'agent-a'), args);
    return { res, row: (await store.list('feedPosts')).items[0] };
  };
  const web = (head: string, images: Record<string, Buffer> = {}) => fakeWeb({ 'https://example.com/a': page(head) }, images);

  it('keeps a model imageUrl that passes verification, with its caption', async () => {
    const { row } = await post({ title: 't', summary: 'b', imageUrl: 'https://img.example/a.jpg', imageCaption: 'The chip on a bench', sourceUrl: 'https://example.com/a' }, web('<meta property="og:image" content="https://other/x.jpg">', { 'https://img.example/a.jpg': jpeg(1200, 630) }));
    expect(row).toMatchObject({ imageUrl: 'https://img.example/a.jpg', imageCaption: 'The chip on a bench' });
  });

  it('drops a model imageUrl that fails the technical check, says so, and never swaps in the page image', async () => {
    const { res, row } = await post({ title: 't', summary: 'b', imageUrl: 'https://img.example/a.jpg', imageCaption: 'x', sourceUrl: 'https://example.com/a' }, web('<meta property="og:image" content="https://example.com/pic.jpg">', { 'https://img.example/a.jpg': jpeg(300, 200), 'https://example.com/pic.jpg': jpeg(1200, 630) }));
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/image was not attached \(too small\)/);
    expect(row?.imageUrl).toBeUndefined();
    expect(row?.imageCaption).toBeUndefined();
  });

  it('never picks an image for the agent: a sourceUrl alone leaves the post without one', async () => {
    const { row } = await post({ title: 't', summary: 'b', sourceUrl: 'https://example.com/a' }, web('<meta property="og:image" content="https://example.com/pic.jpg">', { 'https://example.com/pic.jpg': jpeg(1200, 630) }));
    expect(row?.imageUrl).toBeUndefined();
  });

  it('requires a caption with an image, and an https imageUrl', async () => {
    const noCaption = await post({ title: 't', summary: 'b', imageUrl: 'https://img.example/a.jpg' }, web('', { 'https://img.example/a.jpg': jpeg(1200, 630) }));
    expect(noCaption.res.isError).toBe(true);
    expect(noCaption.row).toBeUndefined();
    const http = await post({ title: 't', summary: 'b', imageUrl: 'http://img.example/a.png', imageCaption: 'x' }, web(''));
    expect(http.res.isError).toBe(true);
    expect(http.row).toBeUndefined();
  });

  it('does not reuse an image the same routine posted in the last 7 days', async () => {
    const store = ownerStore();
    const ctx = routineCtx(store, 'rtn-1');
    const deps = fakeWeb({}, { 'https://img.example/a.jpg': jpeg(1200, 630), 'https://img.example/copy.jpg': jpeg(1200, 630) });
    const tool = createFeedPostTool({ deps });
    await call(tool, ctx, { title: 'One', summary: 's', sourceUrl: 'https://example.com/1', imageUrl: 'https://img.example/a.jpg', imageCaption: 'c' });
    await call(tool, ctx, { title: 'Two', summary: 's', sourceUrl: 'https://example.com/2', imageUrl: 'https://img.example/copy.jpg', imageCaption: 'c' });
    const rows = (await store.list('feedPosts')).items.sort((x, y) => x.title.localeCompare(y.title));
    expect(rows[0]?.imageUrl).toBe('https://img.example/a.jpg');
    expect(rows[1]?.imageUrl).toBeUndefined();
  });
});

describe('goal activity from agent writes', () => {
  it('records created, updated and status entries with the run id, newest first', async () => {
    const store = ownerStore();
    const ctx = toolContext(store, 'agent-a');
    const goal = createGoalUpdateTool();
    expect((await call(goal, ctx, { title: 'Read 12 books', summary: 'Started' })).isError).toBe(false);
    const created = (await store.list('goals')).items[0] as Goal;
    expect(created.activity?.[0]).toMatchObject({ actor: 'agent', kind: 'created', text: 'Read 12 books', runId: 'run-1' });

    await call(goal, ctx, { id: created.id, title: 'Read 12 books', summary: 'Three done' });
    await call(goal, ctx, { id: created.id, title: 'Read 12 books', summary: 'Three done', status: 'done' });
    const latest = await store.get('goals', created.id);
    expect(latest?.activity?.map((entry) => entry.kind)).toEqual(['status', 'updated', 'created']);
    expect(latest?.activity?.[0]?.text).toBe('status: done');
    expect(latest?.activity?.[1]?.text).toBe('Three done');
  });
});

describe('feed_post from a routine run', () => {
  it('stamps the post with its routine and rejects a link that routine already posted, other routines are free', async () => {
    const store = ownerStore();
    const ctx = routineCtx(store, 'rtn-1');
    const post = { title: 'Chip', summary: 'A chip.', sourceUrl: 'https://example.com/chip/' };
    expect((await call(createFeedPostTool(), ctx, post)).isError).toBe(false);
    expect((await store.list('feedPosts')).items[0]).toMatchObject({ routineId: 'rtn-1' });
    const twin = await call(createFeedPostTool(), ctx, { ...post, title: 'Chip again', sourceUrl: 'https://EXAMPLE.com/chip#top' });
    expect(twin).toMatchObject({ isError: true });
    expect(twin.text).toMatch(/already posted/);
    expect((await call(createFeedPostTool(), routineCtx(store, 'rtn-2'), post)).isError).toBe(false);
    expect((await store.list('feedPosts')).items).toHaveLength(2);
  });

  it('leaves routineId off a post made outside a routine', async () => {
    const store = ownerStore();
    await call(createFeedPostTool(), toolContext(store, 'agent-a'), { title: 'Own', summary: 's' });
    expect((await store.list('feedPosts')).items[0]?.routineId).toBeUndefined();
  });
});
