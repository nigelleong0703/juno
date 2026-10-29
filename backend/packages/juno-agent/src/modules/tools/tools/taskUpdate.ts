/**
 * task_update: the agent keeps its own task list (BACKEND 6.5), the way goal_update keeps goals. A task
 * is one piece of real work in this chat: created with a short imperative title, its progress line kept
 * current, finished with a one-line outcome. It belongs to the agent, the conversation and the run that
 * last set it running; a run that ends with it still running closes it (closeRunTasks).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { DeclaredTask, Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { emitAgentStatus } from '../../../execution/agent-status.js';
import { emitDeclaredTask, oneLine } from '../../tasks/agent-tasks.js';
import { isChildRun } from '../../tasks/childDelivery.js';
import { nowIso } from '../util.js';
import { nameRunByAgent } from '../../../execution/harness/services/run-aux.js';

const STATUSES = ['running', 'waiting', 'completed', 'failed'] as const;
const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed']);

const taskUpdateSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  progress: z.string().trim().min(1).max(300).optional(),
  status: z.enum(STATUSES).optional(),
  outcome: z.string().trim().min(1).max(300).optional(),
});
type TaskUpdate = z.infer<typeof taskUpdateSchema>;

function result(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) };
}

/** The fields this call changes; finishing stamps finishedAt, running again clears the outcome's finality. */
function changes(input: TaskUpdate, ctx: ToolContext, at: string): Partial<DeclaredTask> {
  const status = input.status;
  return {
    ...(input.title === undefined ? {} : { title: oneLine(input.title, 200) }),
    ...(input.progress === undefined ? {} : { progress: oneLine(input.progress) }),
    ...(input.outcome === undefined ? {} : { outcome: oneLine(input.outcome) }),
    ...(status === undefined ? {} : { status }),
    // A task set running again moves to the run doing it, so that run's end closes it.
    ...(status === 'running' ? { runId: ctx.runId } : {}),
    ...(status !== undefined && FINISHED.has(status) ? { finishedAt: at } : {}),
    updatedAt: at,
  };
}

async function update(store: Store, ctx: ToolContext, input: TaskUpdate & { id: string }): Promise<ToolResult> {
  const existing = await store.get('agentTasks', input.id);
  if (existing === null || existing.agentId !== ctx.agentId || existing.conversationId !== ctx.conversationId) {
    return result('no task of yours in this chat with id ' + JSON.stringify(input.id) + '.', true);
  }
  if (existing.status === 'stopped') return result('task ' + input.id + ' was stopped by the user; create a new task if you continue the work.', true);
  const updated = await store.patch('agentTasks', input.id, changes(input, ctx, nowIso()));
  await emitDeclaredTask(store, updated);
  return result('Updated task ' + input.id + ' (' + updated.status + ').');
}

async function create(store: Store, ctx: ToolContext, input: TaskUpdate, title: string): Promise<ToolResult> {
  const at = nowIso();
  const task: DeclaredTask = {
    id: 'task-' + randomUUID(),
    agentId: ctx.agentId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    title: oneLine(title, 200),
    status: input.status ?? 'running',
    ...(input.progress === undefined ? {} : { progress: oneLine(input.progress) }),
    ...(input.outcome === undefined ? {} : { outcome: oneLine(input.outcome) }),
    startedAt: at,
    updatedAt: at,
    ...(input.status !== undefined && FINISHED.has(input.status) ? { finishedAt: at } : {}),
  };
  await store.put('agentTasks', task);
  await emitDeclaredTask(store, task);
  await nameRunByAgent(store, ctx.runId, task.title);
  return result('Created task ' + task.id + '. Keep its progress current and finish it with status and outcome.');
}

export function createTaskUpdateTool(opts: { store: Store }): Tool {
  return {
    name: 'task_update',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '' },
        title: { type: 'string', description: '' },
        progress: { type: 'string', description: '' },
        status: { enum: [...STATUSES], description: '' },
        outcome: { type: 'string', description: '' },
      },
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = taskUpdateSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('task_update', args, parsed.error);
      if (isChildRun(await opts.store.get('runs', ctx.runId))) {
        return result('a child task is already on the task list as one task; report your progress in your final result instead.', true);
      }
      const input = parsed.data;
      // One durable step: a replay returns the recorded outcome instead of creating a second task.
      const done = await ctx.step('task_update', async (): Promise<ToolResult> => {
        if (input.id !== undefined) return update(opts.store, ctx, { ...input, id: input.id });
        if (input.title === undefined) return result('a new task needs a title (or pass the id of the task to update).', true);
        return create(opts.store, ctx, input, input.title);
      });
      if (done.isError !== true) await emitAgentStatus(opts.store, ctx.agentId);
      return done;
    },
  };
}
