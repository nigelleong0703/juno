/**
 * tasks_list / task_stop: the agent's own background work, listed and stopped by id, so the model can
 * still find and end it after its context was compacted (Claude Code's /tasks and TaskStop). Covers the
 * background-task registry (shell processes, MCP background calls, wait_for notify) and background child
 * runs, which are read from their run rows and stopped through child_cancel's own checks.
 */
import { z } from 'zod';
import type { BackgroundTask, Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import type { ComputerClient } from '../../../ports/computer/index.js';
import type { ComputerClientProvider } from '../computer/client.js';
import { cancelChildRun } from '../../tasks/childControl.js';
import { isTerminal } from '../../tasks/childRead.js';
import { endBackgroundTask, exitOutcome, stopBackgroundTask } from '../../tasks/background-registry.js';

/** Rows per source in one listing: live work first, then the most recent finished ones. */
export const TASKS_LIST_MAX = 20;
/** Background runs scanned for children; live ones are put first among them. */
const CHILD_SCAN = 100;

const stopSchema = z.object({ taskId: z.string().min(1) });

function text(message: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

/** A registry row whose process or wait may have ended without a report: ask the source, then record it. */
async function refresh(store: Store, client: ComputerClient | undefined, agentId: string, task: BackgroundTask, at: string, signal: AbortSignal): Promise<BackgroundTask> {
  if (task.status !== 'running') return task;
  if (task.kind === 'wait') {
    if ((await store.get('subscriptions', task.id)) !== null) return task;
    return (await endBackgroundTask(store, task.id, 'completed', at)) ?? task;
  }
  // A shell process without notify has no watcher; its state is read now (bounded, the output is not needed).
  if (task.kind !== 'shell' || task.notify || task.handle === undefined || client?.readProcess === undefined) return task;
  try {
    const out = await client.readProcess(agentId, { handle: task.handle, maxBytes: 4 }, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), task.computer);
    if (out.state === 'running') return task;
    const status = out.state === 'exited' ? (out.exitCode === 0 ? 'completed' : 'failed') : out.state === 'stopped' ? 'stopped' : 'failed';
    return (await endBackgroundTask(store, task.id, status, at, out.state === 'exited' ? exitOutcome(out.exitCode) : undefined)) ?? task;
  } catch {
    return task;
  }
}

function readHint(task: BackgroundTask): string {
  if (task.kind === 'shell') return 'output: shell.poll handle=' + (task.handle ?? '?') + ' (or task_done when notify)';
  if (task.kind === 'mcp') return 'result: task_done carries it (output_read for a long one)';
  return 'result: task_done carries the event when it arrives';
}

export function createTasksListTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'tasks_list',
    description: '',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    replay: 'safe',
    sideEffect: false,
    async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const at = new Date().toISOString();
      const client = opts.computer?.();
      const scope = { agentId: ctx.agentId, conversationId: ctx.conversationId };
      // Live rows are queried first, so a long-running job never drops off behind newer finished ones.
      const live = await ctx.store.list('backgroundTasks', { where: { ...scope, status: 'running' }, orderBy: 'at', order: 'desc', limit: TASKS_LIST_MAX });
      const recent = await ctx.store.list('backgroundTasks', { where: scope, orderBy: 'at', order: 'desc', limit: TASKS_LIST_MAX * 2 });
      const liveIds = new Set(live.items.map((task) => task.id));
      const finished = recent.items.filter((task) => task.status !== 'running' && !liveIds.has(task.id));
      const lines: string[] = [];
      for (const row of [...live.items, ...finished].slice(0, TASKS_LIST_MAX)) {
        const task = await refresh(ctx.store, client, ctx.agentId, row, at, ctx.signal);
        lines.push('- ' + task.id + ' · ' + task.kind + ' · ' + task.status + ' · started ' + task.startedAt + ' · ' + task.label + ' · ' + readHint(task));
      }
      const runs = await ctx.store.list('runs', { where: { conversationId: ctx.conversationId, kind: 'background' }, orderBy: 'at', order: 'desc', limit: CHILD_SCAN });
      const children = runs.items
        .filter((run) => run.parentRunId !== undefined)
        .sort((a, b) => Number(isTerminal(a.status)) - Number(isTerminal(b.status)))
        .slice(0, TASKS_LIST_MAX);
      for (const run of children) {
        const state = isTerminal(run.status) ? run.status : run.status + ' (running)';
        lines.push('- ' + run.id + ' · child · ' + state + ' · started ' + run.startedAt + ' · ' + run.title + ' · result: child_wait or child_results; stop: task_stop');
      }
      if (lines.length === 0) return text('No background tasks in this chat.');
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { count: lines.length } };
    },
  };
}

export function createTaskStopTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'task_stop',
    description: '',
    parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = stopSchema.parse(args);
      const task = await ctx.store.get('backgroundTasks', parsed.taskId);
      if (task !== null) {
        if (task.ownerId !== ctx.ownerId || task.agentId !== ctx.agentId || task.conversationId !== ctx.conversationId) return text('Task ' + parsed.taskId + ' is not one of your background tasks in this chat.', true);
        return stopRecord(ctx, opts, task);
      }
      const child = await ctx.store.get('runs', parsed.taskId);
      if (child === null || child.kind !== 'background' || child.parentRunId === undefined || child.conversationId !== ctx.conversationId) {
        return text('No background task ' + parsed.taskId + ' in this chat. Call tasks_list for the ids.', true);
      }
      // The calling run must own the child (or be a later root run that may control its earlier spawner's child), as child_cancel checks.
      const outcome = await cancelChildRun(ctx.store, (runId) => ctx.enqueuer.stopRun(runId), {
        ownerId: ctx.ownerId, agentId: ctx.agentId, parentRunId: ctx.runId, childRunId: child.id, conversationId: ctx.conversationId,
      });
      if (!outcome.ok) return text('Child ' + parsed.taskId + ' could not be stopped (' + outcome.reason + ').', true);
      const message = outcome.state === 'already_terminal' ? 'Child ' + outcome.runId + ' already ended (status ' + outcome.status + ').' : 'Stop requested for child ' + outcome.runId + '; its own terminal state will show it.';
      return text(message);
    },
  };
}

async function stopRecord(ctx: ToolContext, opts: { computer?: ComputerClientProvider }, task: BackgroundTask): Promise<ToolResult> {
  const client = opts.computer?.();
  const method = client?.stopProcess?.bind(client);
  const stopProcess = method === undefined ? undefined : (handle: string) => method(ctx.agentId, { handle }, ctx.signal, task.computer);
  const stopped = await stopBackgroundTask(ctx.store, task, stopProcess, 'agent');
  return text(stopped.text, !stopped.ok);
}
