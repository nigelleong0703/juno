/**
 * The agent task list (BACKEND 6.5) through the real run loop and finalization: plain chat creates no
 * task, task_update keeps one current, a run that ends closes the task it left running (a waiting task
 * stays open), and a subagent is listed from its child run with its title, latest step and result.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import type { AgentTask, Run } from '@agent-desktop/public-contracts';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, Store, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import { createSendMessageTool } from '../../tools/tools/sendMessage.js';
import { createTaskUpdateTool } from '../../tools/tools/taskUpdate.js';
import { NEVER_CANCELLED } from '../../../execution/harness/services/cancel.js';
import { runLoop } from '../../../execution/harness/services/run-loop.js';
import { finalizeTerminalRun } from '../../../execution/harness/services/run-finalize.js';
import { appendRunStep } from '../../../execution/harness/services/run-steps.js';
import type { RunContext, RunInput, RunServices } from '../../../execution/harness/services/run-types.js';
import { agentStatus } from '../../../execution/agent-status.js';
import { emitRunTask } from '../agent-tasks.js';
import { listEndedWork, listLiveWork } from '../work-view.js';

/** Every task of an agent, live first. */
async function listAgentTasks(store: Store, agentId: string): Promise<AgentTask[]> {
  return [...(await listLiveWork(store, { agentId })), ...(await listEndedWork(store, { agentId }, { limit: 50 })).items];
}

const at = '2026-10-13T00:00:00.000Z';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

class ScriptedTurns implements Brain {
  private index = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async buildContext(): Promise<BrainContext> {
    return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' };
  }
  async step(): Promise<AssistantTurn> {
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;
    if (!turn) throw new Error('no scripted turn');
    return turn;
  }
  shouldCompact(): boolean {
    return false;
  }
  async compact(ctx: BrainContext): Promise<BrainContext> {
    return ctx;
  }
}

const call = (id: string, name: string, args: Record<string, unknown>): AssistantTurn => ({ text: '', toolCalls: [{ id, name, arguments: args }], usage, stopReason: 'tool_calls' });
const final = (text: string): AssistantTurn => ({ text, toolCalls: [], usage, stopReason: 'stop' });

const wake: WakeEvent = {
  id: 'wake-1', ownerId: 'owner', agentId: 'agent-1', sessionKey: 'agent-1:conv-1', conversationId: 'conv-1',
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'hi' }, at, status: 'accepted',
};
const input: RunInput = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake] };

function runContext(): RunContext {
  let ids = 0;
  return {
    rand: { uuidv4: () => `id${ids++}` },
    run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>() => ({ id: 'awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

function runRow(id: string, extra: Partial<Run> = {}): Run {
  return {
    id, agentId: 'agent-1', conversationId: 'conv-1', title: 'test', status: 'running', kind: 'chat', steps: [],
    origin: { type: 'owner_message', conversationId: 'conv-1' },
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: at, lastActivityAt: at, ...extra,
  };
}

/** One chat run through the real loop, then the real terminal finalization. */
async function runChat(turns: AssistantTurn[], outcome: 'completed' | 'failed' = 'completed'): Promise<Store & { eventBus: ReturnType<typeof createMemoryStore>['eventBus'] }> {
  const store = createMemoryStore();
  await store.put('runs', runRow('run-1'));
  const tools = [createSendMessageTool({ store, enqueuer: new NoopEnqueuer() }), createTaskUpdateTool({ store })];
  const registry: ToolRegistry = { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
  const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedTurns(turns), toolRegistry: registry };
  await runLoop(runContext(), services, input, 'run-1', { sessionKey: input.sessionKey, agentId: input.agentId }, NEVER_CANCELLED);
  await finalizeTerminalRun(runContext(), services, input, 'run-1', outcome === 'completed' ? { kind: 'completed' } : { kind: 'failed', message: 'model failed' });
  return store;
}

async function taskEvents(store: { eventBus: ReturnType<typeof createMemoryStore>['eventBus'] }): Promise<AgentTask[]> {
  const events = await store.eventBus.since(0, 500);
  return events.flatMap(({ event }) => (event.type === 'task.updated' ? [event.task] : []));
}

describe('agent task list', () => {
  it('a plain chat reply creates no task', async () => {
    const store = await runChat([call('c1', 'send_message', { kind: 'text', text: 'Hi there!' }), final('')]);
    expect(await listAgentTasks(store, 'agent-1')).toEqual([]);
    expect(await taskEvents(store)).toEqual([]);
  });

  it('keeps a declared task current and finishes it with an outcome', async () => {
    const store = await runChat([call('c1', 'task_update', { title: 'Find school dates', status: 'waiting', outcome: 'Asked which school' }), final('Which school?')]);
    const [created] = await listAgentTasks(store, 'agent-1');
    expect(created).toMatchObject({
      kind: 'task', title: 'Find school dates', runId: 'run-1', parentId: 'run-1', rootRunId: 'run-1', depth: 1, conversationId: 'conv-1',
      origin: { type: 'owner_message', conversationId: 'conv-1' }, mode: 'awaited', replyTo: { type: 'none' }, status: 'waiting', waitingFor: 'owner_input',
    });

    // The same task, updated and finished in a later run of the chat.
    const tool = createTaskUpdateTool({ store });
    const ctx = { ownerId: 'owner', agentId: 'agent-1', conversationId: 'conv-1', runId: 'run-2', store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), wake, signal: new AbortController().signal, step: async <T>(_n: string, fn: () => Promise<T>) => fn() };
    await store.put('runs', runRow('run-2'));
    await tool.execute({ id: created?.id, status: 'running', progress: 'Reading the school calendar' }, ctx);
    expect((await agentStatus(store, 'agent-1')).doing).toBe('Reading the school calendar');
    await tool.execute({ id: created?.id, status: 'completed', outcome: 'Listed 16 Sept and Oct school dates' }, ctx);
    const [finished] = await listAgentTasks(store, 'agent-1');
    expect(finished).toMatchObject({ status: 'ended', outcome: 'done', resultLine: 'Listed 16 Sept and Oct school dates', runId: 'run-2' });
    expect(finished?.finishedAt).toBeDefined();
    expect((await taskEvents(store)).map((task) => task.status)).toEqual(['waiting', 'running', 'ended']);
  });

  it('a run that ends closes the task it left running, but a waiting task stays open', async () => {
    const failed = await runChat([call('c1', 'task_update', { title: 'Book a table' }), final('')], 'failed');
    expect((await listAgentTasks(failed, 'agent-1'))[0]).toMatchObject({ title: 'Book a table', status: 'ended', outcome: 'failed' });

    const waiting = await runChat([call('c1', 'task_update', { title: 'Find rain jackets', status: 'waiting', outcome: 'Asked for a size choice to find rain jackets' }), final('Which size?')]);
    expect((await listAgentTasks(waiting, 'agent-1'))[0]).toMatchObject({ status: 'waiting', progress: 'Asked for a size choice to find rain jackets' });
  });

  it('lists a subagent from its child run: title, latest step as progress, result as outcome', async () => {
    const store = createMemoryStore();
    await store.put('runs', runRow('run-parent'));
    const child = {
      ...runRow('run-child', { kind: 'background', parentRunId: 'run-parent', title: 'Find rain jacket options', status: 'running' }),
      origin: { type: 'parent_run' as const, runId: 'run-parent' }, rootOrigin: { type: 'owner_message' as const, conversationId: 'conv-1' }, rootRunId: 'run-parent', depth: 1,
    };
    await store.put('runs', child, { agentId: 'agent-1', conversationId: 'conv-1', kind: 'background', status: 'running' });
    await emitRunTask(store, child, true);
    await appendRunStep(store, 'run-child', { id: 'stp-1', runId: 'run-child', index: 0, kind: 'browser', verb: 'Opened', target: 'uniqlo.com/rain-jackets', status: 'completed', startedAt: at, durationMs: 5 });
    expect((await listAgentTasks(store, 'agent-1'))[0]).toMatchObject({ kind: 'subagent', title: 'Find rain jacket options', status: 'running', progress: 'Opened uniqlo.com/rain-jackets', childRunId: 'run-child', runId: 'run-parent', parentId: 'run-parent', rootRunId: 'run-parent', depth: 1, mode: 'awaited', replyTo: { type: 'parent_run', runId: 'run-parent' }, origin: { type: 'owner_message', conversationId: 'conv-1' } });

    const services: RunServices = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedTurns([final('')]), toolRegistry: { forAgent: async () => [], get: () => undefined } };
    await store.patch('runs', 'run-child', { childResult: 'Found 4 jackets under $60.\nDetails follow.' } as Partial<Run>);
    await finalizeTerminalRun(runContext(), services, { ...input, sessionKey: 'child' }, 'run-child', { kind: 'completed' });
    const [done] = await listAgentTasks(store, 'agent-1');
    expect(done).toMatchObject({ status: 'ended', outcome: 'done', resultLine: 'Found 4 jackets under $60.' });
    expect(done?.progress).toBeUndefined();
    expect((await taskEvents(store)).map((task) => task.status)).toEqual(['running', 'running', 'ended']);
    const wire = (await store.eventBus.since(0, 500)).map((row) => row.event).filter((event) => event.type.startsWith('SUBAGENT_'));
    expect(wire[0]).toMatchObject({
      type: 'SUBAGENT_STARTED',
      subagentRunId: 'run-child',
      name: 'Find rain jacket options',
      metadata: { juno: { parentRunId: 'run-parent', conversationId: 'conv-1' } },
    });
    expect(wire[wire.length - 1]).toMatchObject({
      type: 'SUBAGENT_FINISHED',
      subagentRunId: 'run-child',
      outcome: { type: 'success' },
      result: 'Found 4 jackets under $60.\nDetails follow.',
    });
    // The parent chat run itself is never a task.
    expect((await listAgentTasks(store, 'agent-1')).map((task) => task.id)).toEqual(['run-child']);
  });
});
