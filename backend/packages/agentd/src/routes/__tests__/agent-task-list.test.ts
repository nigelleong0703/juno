/**
 * GET /v1/agents/:id/tasks and POST /v1/tasks/:id/stop (BACKEND 6.5) on the production app: the list holds
 * declared tasks, background jobs and subagents but never a plain chat run; it is owner-scoped (another
 * owner's agent or task answers 404); a stop ends the work and announces it as `task.updated`.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { DeclaredTask, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import type { AgentTask, Run, TaskTree } from '@agent-desktop/public-contracts';
import type { BackgroundTask } from 'juno-agent/contracts';
import { createTestApp, requestAs } from '../../__tests__/test-app.js';
import type { ComputerdClient } from '../../computerd.js';

const A = 'owner-a';
const B = 'owner-b';
const at = '2026-10-13T00:00:00.000Z';

class RecordingEnqueuer implements Enqueuer {
  readonly stopped: string[] = [];
  async enqueue(_event: WakeEvent): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
  async stopRun(runId: string): Promise<void> {
    this.stopped.push(runId);
  }
  async scheduleRoutine(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async runState(): Promise<'running'> {
    return 'running';
  }
}

const OWNER_ORIGIN = { type: 'owner_message' as const, conversationId: 'conv-a' };

function run(id: string, extra: Partial<Run> = {}): Run {
  return {
    id, agentId: 'agent-a', conversationId: 'conv-a', title: 'Chat about lunch', status: 'running', kind: 'chat', steps: [], origin: OWNER_ORIGIN,
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: at, lastActivityAt: at, ...extra,
  };
}

/** A child run `depth` levels under the chat run `run-chat`. */
function childOf(id: string, parentRunId: string, depth: number, extra: Partial<Run> = {}): Run {
  return run(id, { kind: 'background', parentRunId, title: 'Child ' + id, origin: { type: 'parent_run', runId: parentRunId }, rootOrigin: OWNER_ORIGIN, ...extra, ...{ rootRunId: 'run-chat', depth } });
}

function job(id: string, extra: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id, ownerId: A, agentId: 'agent-a', conversationId: 'conv-a', runId: 'run-chat', kind: 'shell', label: 'npm run build',
    title: 'Build the release bundle', handle: 'p1', notify: false, chainId: 'chain', generation: 0, status: 'running', startedAt: at, ...extra,
  };
}

const declared: DeclaredTask = {
  id: 'task-1', agentId: 'agent-a', conversationId: 'conv-a', runId: 'run-chat', title: 'Find school dates',
  status: 'running', progress: 'Reading the school calendar', startedAt: at, updatedAt: at,
};

async function build() {
  const mem = createMemoryStore();
  const enqueuer = new RecordingEnqueuer();
  const processStops: string[] = [];
  const computerd = { stopProcess: async (_agentId: string, handle: string) => { processStops.push(handle); return { handle, state: 'stopped' as const, exitCode: null }; } } as unknown as ComputerdClient;
  const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer, computerd });
  const own = mem.forOwner?.(A) as Store;
  await own.put('agents', { id: 'agent-a', name: 'Atlas' } as never);
  await (mem.forOwner?.(B) as Store).put('agents', { id: 'agent-b', name: 'Bea' } as never);
  await own.put('runs', run('run-chat'));
  await own.put('runs', childOf('run-child', 'run-chat', 1, { title: 'Find rain jacket options' }));
  await own.put('backgroundTasks', job('shell-agent-a-p1'));
  await own.put('agentTasks', declared);
  return { app, mem, enqueuer, processStops };
}

async function tasksOf(app: Awaited<ReturnType<typeof build>>['app'], owner: string, agentId: string): Promise<Response> {
  return requestAs(app, owner, '/v1/agents/' + agentId + '/tasks');
}

describe('agent task list API', () => {
  it('lists declared tasks, background jobs and subagents, never a plain chat run', async () => {
    const { app } = await build();
    const res = await tasksOf(app, A, 'agent-a');
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: AgentTask[] };
    expect(items.map((task) => [task.id, task.kind, task.title]).sort()).toEqual([
      ['run-child', 'subagent', 'Find rain jacket options'],
      ['shell-agent-a-p1', 'command', 'Build the release bundle'],
      ['task-1', 'task', 'Find school dates'],
    ]);
  });

  it('answers another owner exactly like an unknown agent or task', async () => {
    const { app, processStops, enqueuer } = await build();
    expect((await tasksOf(app, B, 'agent-a')).status).toBe(404);
    expect((await tasksOf(app, A, 'agent-ghost')).status).toBe(404);
    for (const id of ['task-1', 'shell-agent-a-p1', 'run-child', 'run-chat', 'nope']) {
      expect((await requestAs(app, B, '/v1/tasks/' + id + '/stop', { method: 'POST' })).status).toBe(404);
    }
    // A plain chat run is not a task, even for its owner.
    expect((await requestAs(app, A, '/v1/tasks/run-chat/stop', { method: 'POST' })).status).toBe(404);
    expect(processStops).toEqual([]);
    expect(enqueuer.stopped).toEqual([]);
  });

  it('stops each kind and announces it', async () => {
    const { app, mem, processStops, enqueuer } = await build();
    const stopped = await requestAs(app, A, '/v1/tasks/shell-agent-a-p1/stop', { method: 'POST' });
    expect(await stopped.json()).toMatchObject({ id: 'shell-agent-a-p1', status: 'ended', outcome: 'cancelled', outcomeDetail: 'stopped_by_owner' });
    expect(processStops).toEqual(['p1']);

    const task = await requestAs(app, A, '/v1/tasks/task-1/stop', { method: 'POST' });
    expect(await task.json()).toMatchObject({ id: 'task-1', status: 'ended', outcome: 'cancelled', outcomeDetail: 'stopped_by_owner', resultLine: 'Stopped by you' });
    expect(enqueuer.stopped).toEqual(['run-chat']);

    const child = await requestAs(app, A, '/v1/tasks/run-child/stop', { method: 'POST' });
    expect(child.status).toBe(200);
    expect(enqueuer.stopped).toEqual(['run-chat', 'run-child']);
    // The requester is on the run row before the signal goes out, whichever process then finishes the stop.
    expect(await mem.get('runs', 'run-child')).toMatchObject({ stoppedBy: 'owner' });

    const events = await mem.eventBus.since(0, 500);
    const updates = events.flatMap(({ event }) => (event.type === 'task.updated' ? [event.task] : []));
    expect(updates.map((update) => [update.id, update.status])).toEqual([['shell-agent-a-p1', 'ended'], ['task-1', 'ended']]);
  });

  it('GET /v1/tasks pages ended work newest start first without repeating or skipping rows that start at the same time', async () => {
    const { app, mem } = await build();
    const own = mem.forOwner?.(A) as Store;
    // Eight ended rows from four sources, all started at the same instant, and two earlier ones.
    for (const index of [1, 2, 3]) await own.put('backgroundTasks', job('shell-agent-a-done' + String(index), { status: 'completed', endedAt: at, startedAt: at, outcome: 'Exited with code 0' }));
    for (const index of [1, 2]) await own.put('agentTasks', { ...declared, id: 'task-done' + String(index), status: 'completed', finishedAt: at });
    for (const index of [1, 2, 3]) await own.put('runs', childOf('run-done' + String(index), 'run-chat', 1, { status: 'completed', finishedAt: at }));
    await own.put('backgroundTasks', job('shell-agent-a-old', { status: 'failed', startedAt: '2026-10-12T00:00:00.000Z', endedAt: at }));
    await own.put('agentTasks', { ...declared, id: 'task-old', status: 'failed', startedAt: '2026-10-11T00:00:00.000Z', finishedAt: at });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await requestAs(app, A, '/v1/tasks?status=ended&limit=3' + (cursor === null ? '' : '&cursor=' + cursor));
      expect(res.status).toBe(200);
      const page = (await res.json()) as { items: AgentTask[]; nextCursor: string | null };
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((task) => task.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(10);
    // Newest first; the two earlier rows come last, the later of them first.
    expect(seen.slice(-2)).toEqual(['shell-agent-a-old', 'task-old']);
  });

  it('GET /v1/tasks returns live work whole and filters by kind; a foreign agent or a bad cursor is refused', async () => {
    const { app } = await build();
    const live = (await (await requestAs(app, A, '/v1/tasks?status=live')).json()) as { items: AgentTask[]; nextCursor: string | null };
    expect(live.items.map((task) => task.id).sort()).toEqual(['run-child', 'shell-agent-a-p1', 'task-1']);
    expect(live.nextCursor).toBeNull();
    const commands = (await (await requestAs(app, A, '/v1/tasks?kind=command')).json()) as { items: AgentTask[] };
    expect(commands.items.map((task) => task.id)).toEqual(['shell-agent-a-p1']);
    expect((await requestAs(app, B, '/v1/tasks?agentId=agent-a')).status).toBe(404);
    expect(((await (await requestAs(app, B, '/v1/tasks')).json()) as { items: AgentTask[] }).items).toEqual([]);
    expect((await requestAs(app, A, '/v1/tasks?cursor=nonsense')).status).toBe(400);
    expect((await requestAs(app, A, '/v1/tasks?status=sleeping')).status).toBe(400);
  });

  it('GET /v1/tasks/:id/tree is every task under the root run, parents first, bounded by the spawn depth, and 404 for another owner', async () => {
    const { app, mem } = await build();
    const own = mem.forOwner?.(A) as Store;
    const spend = (steps: number) => ({ inputTokens: steps, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps });
    await own.patch('runs', 'run-chat', { usage: spend(1) });
    await own.patch('runs', 'run-child', { usage: spend(2) });
    await own.put('runs', childOf('run-grandchild', 'run-child', 2, { usage: spend(4) }));
    await own.put('runs', childOf('run-great', 'run-grandchild', 3, { usage: spend(8) }));
    // Past the spawn limit nothing can exist; a row that did would still not be walked.
    await own.put('runs', childOf('run-too-deep', 'run-great', 4, { usage: spend(16) }));

    for (const entry of ['run-chat', 'task-1', 'shell-agent-a-p1', 'run-great']) {
      const res = await requestAs(app, A, '/v1/tasks/' + entry + '/tree');
      expect(res.status).toBe(200);
      const tree = (await res.json()) as TaskTree;
      expect(tree.rootRunId).toBe('run-chat');
      expect(tree.origin).toEqual(OWNER_ORIGIN);
      // The plain chat run is not a task; its declared task and background job and the child chain are.
      expect(tree.items.map((task) => [task.id, task.depth]).sort()).toEqual([['run-child', 1], ['run-grandchild', 2], ['run-great', 3], ['shell-agent-a-p1', 1], ['task-1', 1]]);
      expect(tree.items.map((task) => task.depth)).toEqual([...tree.items.map((task) => task.depth)].sort());
      expect(tree.subtreeUsage.steps).toBe(1 + 2 + 4 + 8);
    }
    expect((await requestAs(app, B, '/v1/tasks/run-child/tree')).status).toBe(404);
    expect((await requestAs(app, A, '/v1/tasks/nope/tree')).status).toBe(404);
  });
});
