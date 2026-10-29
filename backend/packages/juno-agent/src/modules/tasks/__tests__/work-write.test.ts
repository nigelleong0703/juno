/**
 * What the task tree needs written where the work already writes (BACKEND 6.5): a child run records its root and depth and is
 * found by the indexed parent link however many other runs exist; a background job copies its run's root and records whether a
 * stop reached the call; an uncertain-action review flags the run in the transaction of its card.
 */
import { describe, expect, it } from 'vitest';
import type { Agent, Conversation, Run } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import type { BackgroundTask, Store, StoredRequest } from '../../../contracts/index.js';
import { cancelChildTasks, spawnChildTask, type ChildDispatchAdapter } from '../child.js';
import { cancelChildRun } from '../childControl.js';
import { recordRunStop } from '../stop-record.js';
import { childRunsOf, type ChildRun } from '../childRead.js';
import { recordBackgroundTask, stopBackgroundTask, trackBackgroundCall } from '../background-registry.js';
import { openEffectReview, settleEffectReview } from '../effect-review.js';
import { projectBackground, projectRun, type WorkRun } from '../work-view.js';

const OWNER = 'owner-w';
const AGENT = 'agent-w';
const CONV = 'conv-w';
const ROOT = 'run-root';
const AT = '2026-10-29T00:00:00.000Z';
const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };
const ORIGIN = { type: 'owner_message' as const, conversationId: CONV };

class RecordingAdapter implements ChildDispatchAdapter {
  async startChildRun(): Promise<void> {}
}

const run = (id: string, extra: Partial<Run> = {}): Run => ({ id, agentId: AGENT, conversationId: CONV, title: id, status: 'running', kind: 'chat', steps: [], usage, startedAt: AT, lastActivityAt: AT, origin: ORIGIN, ...extra });

async function seed(): Promise<Store> {
  const raw = createMemoryStore();
  const store = raw.forOwner === undefined ? raw : raw.forOwner(OWNER);
  const agent: Agent = { id: AGENT, name: AGENT, handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: OWNER, createdAt: AT, updatedAt: AT };
  const conversation: Conversation = { id: CONV, kind: 'direct', title: 'p', agentIds: [AGENT], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT };
  await store.put('agents', agent);
  await store.put('conversations', conversation);
  await store.put('runs', run(ROOT), { agentId: AGENT, conversationId: CONV });
  return store;
}

const spawn = (store: Store, parentRunId: string, callId: string) =>
  spawnChildTask(store, { ownerId: OWNER, agentId: AGENT, parentRunId, conversationId: CONV, callId, prompt: 'research flights', targetAgentId: AGENT }, new RecordingAdapter());

describe('child runs in the tree', () => {
  it('records the root, depth and origin once at spawn, and finds the children through the indexed parent link among thousands of runs', async () => {
    const store = await seed();
    const first = await spawn(store, ROOT, 'c1');
    if (!first.ok) throw new Error(first.reason);
    const child: ChildRun | null = await store.get('runs', first.child.runId);
    expect(child).toMatchObject({ parentRunId: ROOT, rootRunId: ROOT, depth: 1, origin: { type: 'parent_run', runId: ROOT }, rootOrigin: ORIGIN });

    const second = await spawn(store, first.child.runId, 'c2');
    if (!second.ok) throw new Error(second.reason);
    expect(await store.get('runs', second.child.runId)).toMatchObject({ rootRunId: ROOT, depth: 2, rootOrigin: ORIGIN });

    // The page-capped scan this replaced threw past 50 pages of 100 runs.
    for (let index = 0; index < 5200; index += 1) await store.put('runs', run('run-noise-' + String(index), { startedAt: '2026-10-28T00:00:00.000Z' }));
    const lists: unknown[] = [];
    const counting: Store = { ...store, list: (async (collection: 'runs', query: never) => { lists.push(query); return store.list(collection, query); }) as Store['list'] };
    expect((await childRunsOf(counting, ROOT)).map((entry) => entry.id)).toEqual([first.child.runId]);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ where: { parentId: ROOT } });
  });
});

describe('who stopped a child run', () => {
  const spawned = async (store: Store, parent: string, callId: string): Promise<string> => {
    const result = await spawn(store, parent, callId);
    if (!result.ok) throw new Error(result.reason);
    return result.child.runId;
  };
  const access = (childRunId: string) => ({ ownerId: OWNER, agentId: AGENT, parentRunId: ROOT, childRunId, conversationId: CONV });

  it('records the agent for its own child_cancel, and the first requester wins over a later cascade', async () => {
    const store = await seed();
    const byAgent = await spawned(store, ROOT, 'cancel-1');
    await cancelChildRun(store, async () => undefined, access(byAgent));
    expect((await store.get('runs', byAgent))?.stoppedBy).toBe('agent');

    // The owner stopped the parent first, so the platform's cascade to its children keeps saying "owner".
    const byOwner = await spawned(store, ROOT, 'cancel-2');
    await recordRunStop(store, ROOT, 'owner');
    await cancelChildTasks(store, async () => undefined, ROOT);
    expect((await store.get('runs', byOwner))?.stoppedBy).toBe('owner');
    expect((await store.get('runs', byAgent))?.stoppedBy).toBe('agent');
  });

  it('records the platform for a cascade from a parent that ended on its own, and never relabels a finished run', async () => {
    const store = await seed();
    const child = await spawned(store, ROOT, 'cascade-1');
    await cancelChildTasks(store, async () => undefined, ROOT);
    expect((await store.get('runs', child))?.stoppedBy).toBe('system');
    await store.patch('runs', child, { status: 'completed' } as Partial<Run>);
    await recordRunStop(store, child, 'owner');
    expect((await store.get('runs', child))?.stoppedBy).toBe('system');
  });
});

const job = (id: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id, ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: ROOT, kind: 'mcp', label: 'crm.update', notify: true, chainId: 'chain', generation: 0, status: 'running', startedAt: AT, ...extra,
});

describe('background jobs in the tree', () => {
  it('copies the root of the run that started the job', async () => {
    const store = await seed();
    await store.put('runs', run('run-kid', { kind: 'background', parentRunId: ROOT }) as ChildRun & Run, { agentId: AGENT, conversationId: CONV });
    await store.patch('runs', 'run-kid', { rootRunId: ROOT, depth: 1 } as Partial<Run>);
    await recordBackgroundTask(store, job('mcp-1', { runId: 'run-kid' }));
    await recordBackgroundTask(store, job('mcp-2', { runId: ROOT }));
    expect((await store.get('backgroundTasks', 'mcp-1'))?.rootRunId).toBe(ROOT);
    expect((await store.get('backgroundTasks', 'mcp-2'))?.rootRunId).toBe(ROOT);
  });

  it('records whether the stop reached the call, so a stop nobody delivered reads as unknown_effect', async () => {
    const store = await seed();
    await recordBackgroundTask(store, job('mcp-held'));
    await recordBackgroundTask(store, job('mcp-elsewhere'));
    const signal = trackBackgroundCall('mcp-held');

    for (const id of ['mcp-held', 'mcp-elsewhere']) {
      const row = await store.get('backgroundTasks', id);
      if (row === null) throw new Error('missing ' + id);
      expect((await stopBackgroundTask(store, row, undefined, 'owner')).ok).toBe(true);
    }
    expect(signal.aborted).toBe(true);
    const held = await store.get('backgroundTasks', 'mcp-held');
    const elsewhere = await store.get('backgroundTasks', 'mcp-elsewhere');
    expect(held).toMatchObject({ status: 'stopped', stopDelivery: 'aborted', stoppedBy: 'owner' });
    expect(elsewhere).toMatchObject({ status: 'stopped', stopDelivery: 'marked', stoppedBy: 'owner' });
    expect(await projectBackground(store, held as BackgroundTask)).toMatchObject({ status: 'ended', outcome: 'cancelled', outcomeDetail: 'stopped_by_owner' });
    expect(await projectBackground(store, elsewhere as BackgroundTask)).toMatchObject({ status: 'ended', outcome: 'unknown_effect', outcomeDetail: 'stop_unconfirmed' });
  });
});

describe('effect review on a routine run', () => {
  const request = (id: string, state: 'pending' | 'user_reported_succeeded' | 'user_confirmed_not_executed' | 'still_unknown'): StoredRequest => ({
    id, kind: 'question', status: state === 'pending' ? 'pending' : 'answered', title: 't', summary: 's', agentId: AGENT, conversationId: CONV, runId: 'run-routine',
    payload: { kind: 'question', ui: { version: 1, title: 't', blocks: [] } }, createdAt: AT,
    reconciliation: { stepId: 'stp-' + id, tool: 'crm.update', fingerprint: 'f', reason: 'r', state },
  });

  it('stays open until every uncertain action is settled, and the task shows it live and after the run ends', async () => {
    const store = await seed();
    await store.put('runs', run('run-routine', { kind: 'routine', routineId: 'rt-1', origin: { type: 'routine', routineId: 'rt-1', occurrenceAt: AT } }), { agentId: AGENT, conversationId: CONV });
    const read = async () => projectRun(store, (await store.get('runs', 'run-routine')) as WorkRun);

    await store.put('requests', request('req-1', 'pending'));
    await store.put('requests', request('req-2', 'pending'));
    await openEffectReview(store, 'run-routine');
    expect(await read()).toMatchObject({ kind: 'routine', status: 'waiting', waitingFor: 'effect_review' });

    // The owner reports the first one done: the second is still open.
    await store.put('requests', request('req-1', 'user_reported_succeeded'));
    await settleEffectReview(store, request('req-1', 'user_reported_succeeded'));
    expect((await store.get('runs', 'run-routine'))?.effectReview).toBe('open');

    // The run finishes while the second card is unanswered: the outcome is unknown, not done.
    await store.patch('runs', 'run-routine', { status: 'completed', finishedAt: AT });
    expect(await read()).toMatchObject({ status: 'ended', outcome: 'unknown_effect', outcomeDetail: 'effect_review' });

    // "Still unknown" keeps it open; a report settles it.
    await store.put('requests', request('req-2', 'still_unknown'));
    await settleEffectReview(store, request('req-2', 'still_unknown'));
    expect((await store.get('runs', 'run-routine'))?.effectReview).toBe('open');
    await store.put('requests', request('req-2', 'user_confirmed_not_executed'));
    await settleEffectReview(store, request('req-2', 'user_confirmed_not_executed'));
    expect(await read()).toMatchObject({ status: 'ended', outcome: 'done' });
  });
});
