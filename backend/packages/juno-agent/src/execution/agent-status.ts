import type { Store } from '../contracts/index.js';
import type { Agent, AgentStatus, Run } from '@agent-desktop/public-contracts';
import { canonicalPlanId } from '../modules/tasks/state.js';
import { runningTaskLine } from '../modules/tasks/agent-tasks.js';

/** Live agent state, computed from the store on every read and never persisted (BACKEND §10.7). */
export interface AgentStatusSnapshot {
  status: AgentStatus;
  /** Pending requests waiting on the user for this agent. */
  needsYou: number;
  /** What the agent is doing right now; only while `status` is `working`. */
  doing?: string;
}

const PENDING_REQUEST_CAP = 100;
const RECENT_RUN_WINDOW = 20;

/** Upkeep the user did not ask for (memory jobs and the like) is a background run with no parent; a delegated child is a background run too, but it is the agent's work. */
const isUpkeep = (run: Run): boolean => run.kind === 'background' && run.parentRunId === undefined;

/** Runs executing now: `running`, or a reserved child still `queued`. A run parked on a request is not working. */
async function activeRuns(store: Store, agentId: string): Promise<Run[]> {
  const running = await store.list('runs', { where: { agentId, status: 'running' }, limit: 100 });
  const queued = await store.list('runs', { where: { agentId, status: 'queued' }, limit: 100 });
  return [...running.items, ...queued.items].filter((run) => !isUpkeep(run)).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/** The newest top-level run (child failures are reported through their parent) failed, and nothing newer exists. */
async function lastRunFailed(store: Store, agentId: string): Promise<boolean> {
  const recent = await store.list('runs', { where: { agentId }, orderBy: 'at', order: 'desc', limit: RECENT_RUN_WINDOW });
  const latest = recent.items.find((run) => run.parentRunId === undefined && !isUpkeep(run));
  return latest?.status === 'failed';
}

/** The in-progress todo of this run's plan: the child's own plan for a child run, else the chat's canonical plan. */
async function inProgressTodo(store: Store, run: Run): Promise<string | undefined> {
  const plans = run.parentRunId !== undefined
    ? (await store.list('items', { where: { runId: run.id, agentId: run.agentId }, limit: 20 })).items
    : run.conversationId === undefined
      ? []
      : [await store.get('items', canonicalPlanId(run.agentId, run.conversationId))];
  for (const plan of plans) {
    if (plan?.type !== 'plan') continue;
    const todo = plan.todos.find((candidate) => candidate.status === 'in_progress');
    if (todo !== undefined) return todo.text;
  }
  return undefined;
}

/**
 * The agent's own running task's progress (task_update), else the in-progress todo, else the latest step
 * ("verb target"), else the run title unless it is the generic fallback.
 */
async function doingLine(store: Store, agentId: string, runs: readonly Run[]): Promise<string | undefined> {
  const task = await runningTaskLine(store, agentId);
  if (task !== undefined) return task;
  for (const run of runs) {
    const todo = await inProgressTodo(store, run);
    if (todo !== undefined) return todo;
  }
  // Background upkeep (memory jobs and the like) never becomes the activity line.
  const newest = runs.find((run) => !isUpkeep(run));
  if (newest === undefined) return undefined;
  const step = newest.steps.at(-1);
  if (step !== undefined) return step.verb + ' ' + step.target;
  const title = newest.title.trim();
  // A title still holding raw @mentions is the unprocessed room message, not an activity.
  return title === '' || title === 'New task' || /(^|\s)@\S/u.test(title) ? undefined : title;
}

/**
 * Precedence: working > needs_you > paused > error > idle.
 * - working: any run of the agent (any session, child runs included) is `running` or `queued`;
 * - needs_you: a pending request (approval, sign-in, secure input, ...) for the agent; a question or connect card in a direct chat does not count;
 * - paused: the agent has `pausedAt`;
 * - error: the agent's newest top-level run failed (any later run clears it);
 * - idle: otherwise.
 * The store is owner-scoped (request/Restate owner scope), so only this owner's rows count.
 */
export async function agentStatus(store: Store, agentId: string): Promise<AgentStatusSnapshot> {
  const active = await activeRuns(store, agentId);
  const pending = await store.list('requests', { where: { agentId, status: 'pending' }, limit: PENDING_REQUEST_CAP });
  // A question or connect card in a direct chat is part of the conversation (the user is already there), not something the agent is stuck on.
  let needsYou = 0;
  for (const request of pending.items) {
    const inChat = (request.kind === 'question' || request.kind === 'connect') && request.conversationId !== undefined;
    if (!inChat || (await store.get('conversations', request.conversationId!))?.kind !== 'direct') needsYou += 1;
  }
  if (active.length > 0) {
    const doing = await doingLine(store, agentId, active);
    return { status: 'working', needsYou, ...(doing === undefined ? {} : { doing }) };
  }
  if (needsYou > 0) return { status: 'needs_you', needsYou };
  const agent = await store.get('agents', agentId);
  if (agent?.pausedAt !== undefined) return { status: 'paused', needsYou };
  return { status: (await lastRunFailed(store, agentId)) ? 'error' : 'idle', needsYou };
}

/** An agent row with the derived fields overlaid, as the API returns it (the stored status is ignored). */
export async function withLiveStatus(store: Store, agent: Agent): Promise<Agent> {
  const { status, needsYou, doing } = await agentStatus(store, agent.id);
  return { ...agent, status, needsYou, ...(doing === undefined ? {} : { doing }) };
}

/** Emit the recomputed snapshot; it is a full snapshot, so emitting twice is harmless. */
export async function emitAgentStatus(store: Store, agentId: string): Promise<void> {
  const { status, doing } = await agentStatus(store, agentId);
  await store.emit({ type: 'agent.status', agentId, status, ...(doing === undefined ? {} : { doing }) });
}
