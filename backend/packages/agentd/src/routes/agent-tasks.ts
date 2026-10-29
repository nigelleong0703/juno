/**
 * The task tree and one agent's todo plans.
 *
 * GET /v1/tasks (BACKEND 6.5) lists the owner's tasks: the agent's declared tasks, delegated child runs, routine runs
 * and background jobs, as one projection (`AgentTask`) read from the rows each mechanism already keeps. Live tasks come
 * back whole, ended ones a page at a time newest start first. GET /v1/tasks/:id/tree is every task under one root run.
 * GET /v1/agents/:id/tasks is the same list for one agent. POST /v1/tasks/:id/stop stops one. GET /v1/agents/:id/plans
 * (GC12; `tasks` before 0.3) returns the authoritative latest plan per conversation, including done entries, so the
 * frontend can flatten only the outstanding todos. Every request runs against the owner-scoped store; visibility is
 * checked the same way as GET /v1/agents/:id, and a foreign task id answers exactly like an unknown one.
 */
import { type Hono } from 'hono';
import { z } from 'zod';
import { NotFoundError, type DeclaredTask } from '@agent-desktop/contracts';
import { todoCheckSchema, workKindSchema, type Agent, type AgentTask } from '@agent-desktop/public-contracts';
import { emitAgentStatus } from 'juno-agent/execution/agent-status';
import { emitDeclaredTask } from 'juno-agent/modules/tasks/agent-tasks';
import { stopBackgroundTask } from 'juno-agent/modules/tasks/background-registry';
import {
  decodePosition, encodePosition, isWorkRun, listEndedWork, listLiveWork, projectBackground, projectDeclared, projectRun, rootRunIdOf,
  taskTree, TASKS_PAGE_DEFAULT, TASKS_PAGE_MAX, type WorkFilter,
} from 'juno-agent/modules/tasks/work-view';
import { stopRunTruthfully } from './runs.js';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { isAgentVisible } from './relationships.js';
import { listTaskPlans } from 'juno-agent/modules/tasks/state';
import { setTodoChecks } from 'juno-agent/modules/tasks/plan-write';

/** The user's configured completion evidence for one task: bounded count, exact specs. */
const configureChecksSchema = z.object({
  conversationId: z.string().min(1),
  todoId: z.string().min(1),
  checks: z.array(todoCheckSchema).max(10),
  /** Optional child scope: the reserved child plan id when the caller configures a child run's task. */
  planId: z.string().min(1).optional(),
});

const listQuerySchema = z.object({
  agentId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  kind: workKindSchema.optional(),
  routineId: z.string().min(1).optional(),
  rootRunId: z.string().min(1).optional(),
  status: z.enum(['live', 'ended']).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(TASKS_PAGE_MAX).default(TASKS_PAGE_DEFAULT),
});
type ListQuery = z.infer<typeof listQuerySchema>;

type ErrorBody = { error: { code: string; message: string } };
type Visible = { agent: Agent } | { error: ErrorBody; status: 403 | 404 };

/** The agent when this owner may see it (the same rule as GET /v1/agents/:id). */
async function visibleAgent(deps: AgentdDeps, id: string, ownerId: string): Promise<Visible> {
  const agent = await deps.store.get('agents', id);
  if (!agent) return { error: { error: { code: 'AGENT_NOT_FOUND', message: 'Agent ' + id + ' not found' } }, status: 404 };
  if (!isAgentVisible(agent, ownerId)) return { error: { error: { code: 'AGENT_FORBIDDEN', message: 'Agent not shared with you' } }, status: 403 };
  return { agent };
}

/**
 * The page for a filter: `live` all the live tasks; `ended` the page after `cursor`; no status the live tasks and the
 * first ended page (or just the next ended page when a cursor is given).
 */
async function listPage(deps: AgentdDeps, filter: WorkFilter, query: ListQuery): Promise<{ items: AgentTask[]; nextCursor: string | null } | 'bad_cursor'> {
  const position = query.cursor === undefined ? undefined : decodePosition(query.cursor);
  if (position === null) return 'bad_cursor';
  const live = query.status === 'ended' || query.cursor !== undefined ? [] : await listLiveWork(deps.store, filter);
  if (query.status === 'live') return { items: live, nextCursor: null };
  const page = await listEndedWork(deps.store, filter, { limit: query.limit, ...(position === undefined ? {} : { cursor: position }) });
  return { items: [...live, ...page.items], nextCursor: page.next === null ? null : encodePosition(page.next) };
}

/** A task by id as it now stands; a source row that is not (or no longer) a task reads as unknown. */
async function taskNow(read: Promise<AgentTask | null>, id: string): Promise<AgentTask> {
  const task = await read;
  if (task === null) throw new NotFoundError('tasks', id);
  return task;
}

/**
 * Stop one task by id, whatever it is: a declared task is marked stopped and the run doing it is stopped;
 * a registry job goes through task_stop's own path; a subagent's or routine's run is stopped like POST /v1/runs/:id/stop.
 * Returns the task as it now stands (a run whose stop was signalled still shows running until it ends, which emits
 * `task.updated`), null for an unknown or foreign id, 'failed' when no stop was delivered.
 */
async function stopTask(deps: AgentdDeps, id: string): Promise<AgentTask | null | 'failed'> {
  const declared = await deps.store.get('agentTasks', id);
  if (declared !== null) return stopDeclared(deps, declared);
  const job = await deps.store.get('backgroundTasks', id);
  if (job !== null) {
    const computerd = deps.computerd;
    // A command started on the owner's Mac (My Mac) is stopped there, not in the sandbox.
    const onMac = job.computer === 'mac';
    const stopProcess = computerd === undefined ? undefined : (handle: string) => computerd.stopProcess(job.agentId, handle, new AbortController().signal, onMac ? 'mac' : undefined);
    const stopped = await stopBackgroundTask(deps.store, job, stopProcess, 'owner');
    if (!stopped.ok) return 'failed';
    return taskNow(projectBackground(deps.store, (await deps.store.get('backgroundTasks', id)) ?? job), id);
  }
  const run = await deps.store.get('runs', id);
  if (run === null || !isWorkRun(run)) return null;
  const outcome = await stopRunTruthfully(deps, run);
  if (outcome === 'failed') return 'failed';
  return taskNow(projectRun(deps.store, outcome === 'signalled' ? run : outcome), id);
}

async function stopDeclared(deps: AgentdDeps, task: DeclaredTask): Promise<AgentTask | 'failed'> {
  if (task.status !== 'running' && task.status !== 'waiting') return taskNow(projectDeclared(deps.store, task), task.id);
  const run = task.runId === undefined ? null : await deps.store.get('runs', task.runId);
  if (run !== null && (await stopRunTruthfully(deps, run)) === 'failed') return 'failed';
  const at = new Date().toISOString();
  const stopped = await deps.store.patch('agentTasks', task.id, { status: 'stopped', stoppedBy: 'owner', updatedAt: at, finishedAt: at, outcome: 'Stopped by you' });
  await emitDeclaredTask(deps.store, stopped);
  await emitAgentStatus(deps.store, stopped.agentId);
  return taskNow(projectDeclared(deps.store, stopped), task.id);
}

export function registerAgentTasks(app: Hono, deps: AgentdDeps) {
  app.get('/v1/tasks', async (c) => {
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: { code: 'INVALID_TASK_QUERY', message: 'Unknown status or kind, or a limit outside 1-' + String(TASKS_PAGE_MAX) } }, 400);
    const { agentId, conversationId, kind, routineId, rootRunId } = query.data;
    if (agentId !== undefined) {
      const visible = await visibleAgent(deps, agentId, getOwnerId(c));
      if ('error' in visible) return c.json(visible.error, visible.status);
    }
    // One whole tree: every task under a root run (an unknown or foreign root is 404, like the tree route).
    if (rootRunId !== undefined) {
      const tree = await taskTree(deps.store, rootRunId);
      if (tree === null) throw new NotFoundError('runs', rootRunId);
      const items = tree.items.filter((task) => (kind === undefined || task.kind === kind) && (agentId === undefined || task.agentId === agentId) && (conversationId === undefined || task.conversationId === conversationId));
      return c.json({ items, nextCursor: null });
    }
    const filter: WorkFilter = { ...(agentId === undefined ? {} : { agentId }), ...(conversationId === undefined ? {} : { conversationId }), ...(kind === undefined ? {} : { kind }), ...(routineId === undefined ? {} : { routineId }) };
    const page = await listPage(deps, filter, query.data);
    if (page === 'bad_cursor') return c.json({ error: { code: 'INVALID_CURSOR', message: 'The cursor is not one this list returned' } }, 400);
    return c.json(page);
  });

  app.get('/v1/tasks/:id/tree', async (c) => {
    const id = c.req.param('id');
    const root = await rootRunIdOf(deps.store, id);
    const tree = root === null ? null : await taskTree(deps.store, root);
    if (tree === null) throw new NotFoundError('tasks', id);
    return c.json(tree);
  });

  app.get('/v1/agents/:id/tasks', async (c) => {
    const visible = await visibleAgent(deps, c.req.param('id'), getOwnerId(c));
    if ('error' in visible) return c.json(visible.error, visible.status);
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: { code: 'INVALID_TASK_QUERY', message: 'Unknown status or kind, or a limit outside 1-' + String(TASKS_PAGE_MAX) } }, 400);
    const page = await listPage(deps, { agentId: visible.agent.id, ...(query.data.kind === undefined ? {} : { kind: query.data.kind }) }, query.data);
    if (page === 'bad_cursor') return c.json({ error: { code: 'INVALID_CURSOR', message: 'The cursor is not one this list returned' } }, 400);
    return c.json(page);
  });

  app.post('/v1/tasks/:id/stop', async (c) => {
    const stopped = await stopTask(deps, c.req.param('id'));
    if (stopped === 'failed') return c.json({ error: { code: 'STOP_FAILED', message: 'The stop could not be delivered; the task is unchanged. Try again.' } }, 502);
    if (stopped === null) throw new NotFoundError('tasks', c.req.param('id'));
    return c.json(stopped);
  });

  app.get('/v1/agents/:id/plans', async (c) => {
    const visible = await visibleAgent(deps, c.req.param('id'), getOwnerId(c));
    if ('error' in visible) return c.json(visible.error, visible.status);
    const agent = visible.agent;
    const items = await listTaskPlans(deps.store, agent.id);
    return c.json({ items, nextCursor: null });
  });

  // The configuration path for completion evidence: the user states exactly what must be true before
  // a task counts as done. The model has no equivalent call, so it can never configure its own checks.
  app.patch('/v1/agents/:id/tasks/checks', async (c) => {
    const visible = await visibleAgent(deps, c.req.param('id'), getOwnerId(c));
    if ('error' in visible) return c.json(visible.error, visible.status);
    const agent = visible.agent;
    const parsed = configureChecksSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_CHECKS', message: 'checks must name a conversation, a todo and 1-10 exact checks' } }, 400);
    }
    // A child plan id is only honoured for a plan this agent and conversation really own; the store
    // helper re-validates the scope, so the route never redirects a write across scopes.
    const plan = await setTodoChecks(
      deps.store, agent.id, parsed.data.conversationId, parsed.data.todoId, parsed.data.checks, parsed.data.planId,
    );
    if (!plan) {
      return c.json({ error: { code: 'PLAN_NOT_FOUND', message: 'No task plan with that todo' } }, 404);
    }
    return c.json(plan);
  });
}
