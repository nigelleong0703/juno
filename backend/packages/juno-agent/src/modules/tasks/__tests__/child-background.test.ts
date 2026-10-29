/**
 * H-69/H-70/H-75: background child tasks (child_spawn with notify). The child records where it reports
 * back and its chain generation; it never holds the parent's final reply; its terminal state is sent to
 * the spawning session as exactly one task_done carrying its result; generations and background
 * runs per chain are capped so woken runs cannot spawn forever.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import type { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore } from '../../../testing/store.js';
import type { Enqueuer, Store, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import type { Agent, Conversation, Run } from '@agent-desktop/public-contracts';
import { createToolRegistry } from '../../tools/index.js';
import { CHILD_CONCURRENCY_LIMIT, spawnChildTask, type ChildDispatchAdapter } from '../child.js';
import { MAX_BACKGROUND_GENERATIONS, MAX_BACKGROUND_PER_CHAIN } from '../child-background.js';
import type { ChildRun } from '../childRead.js';
import { activeChildren } from '../../../execution/harness/services/child-completion.js';
import { notifyBackgroundParent } from '../../../execution/harness/services/child-notify.js';

const OWNER = 'owner-bg';
const AGENT = 'agent-bg';
const CONV = 'conv-bg';
const PARENT = 'run-parent-bg';
const AT = '2026-10-09T00:00:00.000Z';
const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };

class RecordingAdapter implements ChildDispatchAdapter {
  readonly started: string[] = [];
  async startChildRun(input: { runId: string }): Promise<void> { this.started.push(input.runId); }
}

const enqueuer: Enqueuer = {
  enqueue: async () => ({ accepted: true }), stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {},
};

function agentRecord(): Agent {
  return { id: AGENT, name: AGENT, handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: OWNER, createdAt: AT, updatedAt: AT };
}

function conversationRecord(): Conversation {
  return { id: CONV, kind: 'direct', title: 'p', agentIds: [AGENT], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT };
}

async function seedWorld(): Promise<Store> {
  const raw = createMemoryStore();
  const store = raw.forOwner === undefined ? raw : raw.forOwner(OWNER);
  await store.put('agents', agentRecord());
  await store.put('conversations', conversationRecord());
  const parent: Run = { id: PARENT, agentId: AGENT, conversationId: CONV, title: 'parent', status: 'running', kind: 'chat', steps: [], usage, startedAt: AT, lastActivityAt: AT };
  await store.put('runs', parent, { agentId: AGENT, conversationId: CONV });
  return store;
}

function spawnInput(callId: string, notify?: { chainId: string; generation: number }) {
  return {
    ownerId: OWNER, agentId: AGENT, parentRunId: PARENT, conversationId: CONV, callId,
    prompt: 'research flights', targetAgentId: AGENT, ...(notify === undefined ? {} : { notify }),
  };
}

function wakeOf(kind: WakeEvent['kind'], payload: Record<string, unknown> = {}, hop?: WakeEvent['hop']): WakeEvent {
  return {
    id: 'w-' + kind, ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV, kind,
    origin: { type: kind === 'user_message' ? 'user' : 'system' }, trusted: kind === 'user_message', priority: 'user',
    payload, ...(hop === undefined ? {} : { hop }), at: AT, status: 'accepted',
  };
}

function ctxFor(store: Store, wake: WakeEvent, stepId: string): ToolContext {
  return { ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: PARENT, stepId, store, blobs: createMemoryBlobStore(), enqueuer, wake, step: async (_name, fn) => fn(), signal: new AbortController().signal };
}

/** A RunBodyContext slice: ctx.run executes inline, sendWake records. */
function notifyCtx() {
  const sent: WakeEvent[] = [];
  const run = <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => action() as unknown as RestatePromise<T>;
  return { sent, ctx: { run, sendWake: (wake: WakeEvent) => { sent.push(wake); } } };
}

function text(result: ToolResult): string {
  const part = result.content[0];
  return part !== undefined && part.type === 'text' ? part.text : '';
}

describe('background child tasks', () => {
  it('records the reporting session and generation, and never holds the parent final reply', async () => {
    const store = await seedWorld();
    const spawned = await spawnChildTask(store, spawnInput('stp-1', { chainId: 'chain-1', generation: 1 }), new RecordingAdapter());
    if (!spawned.ok) throw new Error(spawned.reason);
    expect(spawned.child.background).toBe(true);
    const row: ChildRun | null = await store.get('runs', spawned.child.runId);
    expect(row?.notifyParent).toEqual({ ownerId: OWNER, agentId: AGENT, conversationId: CONV, chainId: 'chain-1', generation: 1 });
    const awaited = await spawnChildTask(store, spawnInput('stp-2'), new RecordingAdapter());
    if (!awaited.ok) throw new Error(awaited.reason);
    expect((await activeChildren(store, PARENT)).map((c) => c.runId)).toEqual([awaited.child.runId]);
  });

  it('refuses a spawn past the generation cap', async () => {
    const store = await seedWorld();
    const refused = await spawnChildTask(store, spawnInput('stp-1', { chainId: 'c', generation: MAX_BACKGROUND_GENERATIONS + 1 }), new RecordingAdapter());
    expect(refused).toEqual({ ok: false, reason: 'background_limit' });
  });

  it('sends exactly one task_done with the child result to the spawning session', async () => {
    const store = await seedWorld();
    const spawned = await spawnChildTask(store, spawnInput('stp-1', { chainId: 'chain-9', generation: 2 }), new RecordingAdapter());
    if (!spawned.ok) throw new Error(spawned.reason);
    await store.patch('runs', spawned.child.runId, { status: 'completed', childResult: 'SIN-KUL from S$137' });
    const { sent, ctx } = notifyCtx();
    await notifyBackgroundParent(ctx, store, spawned.child.runId, 'completed');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      id: spawned.child.runId + ':done', kind: 'task_done', sessionKey: AGENT + ':' + CONV, trusted: false, priority: 'background',
      hop: { chainId: 'chain-9', depth: 0 },
      payload: { taskId: spawned.child.runId, taskKind: 'child', status: 'completed', summary: 'SIN-KUL from S$137', generation: 2 },
    });
  });

  it('does not wake the parent for a stopped child (user Stop, child_cancel, parent end)', async () => {
    const store = await seedWorld();
    const spawned = await spawnChildTask(store, spawnInput('stp-1', { chainId: 'c', generation: 1 }), new RecordingAdapter());
    if (!spawned.ok) throw new Error(spawned.reason);
    await store.patch('runs', spawned.child.runId, { status: 'stopped' });
    const { sent, ctx } = notifyCtx();
    await notifyBackgroundParent(ctx, store, spawned.child.runId, 'stopped');
    expect(sent).toEqual([]);
  });

  it('caps the total background runs one chain may spawn, even when every earlier one finished', async () => {
    const store = await seedWorld();
    for (let i = 0; i < MAX_BACKGROUND_PER_CHAIN; i += 1) {
      const row: ChildRun = {
        id: 'done-' + i, agentId: AGENT, conversationId: CONV, parentRunId: 'run-old', title: 'x', status: 'completed', kind: 'background', steps: [], usage, startedAt: AT, lastActivityAt: AT,
        notifyParent: { ownerId: OWNER, agentId: AGENT, conversationId: CONV, chainId: 'chain-full', generation: 1 },
      };
      await store.put('runs', row, { agentId: AGENT, conversationId: CONV, kind: 'background', status: 'completed' });
    }
    expect(await spawnChildTask(store, spawnInput('stp-1', { chainId: 'chain-full', generation: 1 }), new RecordingAdapter())).toEqual({ ok: false, reason: 'background_limit' });
    const other = await spawnChildTask(store, spawnInput('stp-2', { chainId: 'chain-fresh', generation: 1 }), new RecordingAdapter());
    expect(other.ok).toBe(true);
  });

  it('how many child tasks a run may have active is the spawning agent\'s maxSubTasks, else the default', async () => {
    const store = await seedWorld();
    for (let i = 0; i < CHILD_CONCURRENCY_LIMIT; i += 1) expect((await spawnChildTask(store, spawnInput('d-' + i), new RecordingAdapter())).ok).toBe(true);
    expect(await spawnChildTask(store, spawnInput('d-over'), new RecordingAdapter())).toEqual({ ok: false, reason: 'concurrency_exceeded' });

    const own = await seedWorld();
    await own.patch('agents', AGENT, { maxSubTasks: CHILD_CONCURRENCY_LIMIT + 2 });
    for (let i = 0; i < CHILD_CONCURRENCY_LIMIT + 2; i += 1) expect((await spawnChildTask(own, spawnInput('o-' + i), new RecordingAdapter())).ok).toBe(true);
    expect(await spawnChildTask(own, spawnInput('o-over'), new RecordingAdapter())).toEqual({ ok: false, reason: 'concurrency_exceeded' });

    const one = await seedWorld();
    await one.patch('agents', AGENT, { maxSubTasks: 1 });
    expect((await spawnChildTask(one, spawnInput('s-1'), new RecordingAdapter())).ok).toBe(true);
    expect(await spawnChildTask(one, spawnInput('s-2'), new RecordingAdapter())).toEqual({ ok: false, reason: 'concurrency_exceeded' });
  });

  it('sends nothing for an awaited (non-background) child', async () => {
    const store = await seedWorld();
    const spawned = await spawnChildTask(store, spawnInput('stp-1'), new RecordingAdapter());
    if (!spawned.ok) throw new Error(spawned.reason);
    const { sent, ctx } = notifyCtx();
    await notifyBackgroundParent(ctx, store, spawned.child.runId, 'completed');
    expect(sent).toEqual([]);
  });

  it('the tool continues the chain one generation deeper from a task_done wake', async () => {
    const store = await seedWorld();
    const registry = await createToolRegistry({ store, enqueuer, childDispatch: new RecordingAdapter() });
    const tool = registry.get('child_spawn');
    if (tool === undefined) throw new Error('child_spawn missing');
    const woken = wakeOf('task_done', { taskId: 'old', taskKind: 'child', status: 'completed', summary: 's', generation: 2 }, { chainId: 'chain-7', depth: 0 });
    const result = await tool.execute({ prompt: 'next step', notify: true }, ctxFor(store, woken, 'stp-a'));
    expect(result.isError).not.toBe(true);
    const spawnedId = text(result).split(' ')[3] ?? '';
    const row: ChildRun | null = await store.get('runs', spawnedId);
    expect(row?.notifyParent).toMatchObject({ chainId: 'chain-7', generation: 3 });
    const capped = await tool.execute({ prompt: 'one more', notify: true }, ctxFor(store, { ...woken, payload: { ...woken.payload, generation: 3 } }, 'stp-b'));
    expect(capped.isError).toBe(true);
    expect(text(capped)).toContain('background task limit');
  });
});
