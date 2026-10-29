/**
 * Task-plan setters (GC12).
 *
 * The configuration and hook paths that mutate one stored plan: checks, blocked state and
 * observed evidence. A runId selects the run current binding so a child run targets only its
 * own scope; a malformed binding refuses without touching the root plan.
 */
import type { Store } from '../../contracts/index.js';
import type { Todo, TodoCheck, TodoEvidence } from '@agent-desktop/public-contracts';
import { emitAgentStatus } from '../../execution/agent-status.js';
import { isOpen, readTaskPlan, type TaskPlan } from './state.js';
import { planForRun, planForTarget } from './plan-target.js';

/** Replace one task checks; an explicit empty list genuinely clears them. runId selects the run current binding. */
export async function setTodoChecks(
  store: Store,
  agentId: string,
  conversationId: string,
  todoId: string,
  checks: TodoCheck[],
  planId?: string,
  runId?: string,
): Promise<TaskPlan | null> {
  const plan = await planForTarget(store, agentId, conversationId, planId, runId);
  if (plan === null) return null;
  if (!plan.todos.some((todo) => todo.id === todoId)) return null;
  const todos = plan.todos.map((todo) => (todo.id === todoId ? { ...todo, checks } : todo));
  return putPlan(store, agentId, conversationId, plan, todos);
}

/** Mark every open todo blocked in the targeted scope only; a child block never mutates the root. */
export async function blockOpenTasks(
  store: Store,
  agentId: string,
  conversationId: string,
  reason: string,
  runId?: string,
): Promise<TaskPlan | null> {
  const note = reason.trim();
  if (note.length === 0) throw new Error('blockOpenTasks requires a non-empty reason note');
  const plan = runId === undefined ? await readTaskPlan(store, agentId, conversationId) : await planForRun(store, agentId, conversationId, runId);
  if (!plan) return null;
  if (!plan.todos.some(isOpen)) return plan;
  const todos = plan.todos.map((todo) => (isOpen(todo) ? { ...todo, status: 'blocked' as const, note } : todo));
  return putPlan(store, agentId, conversationId, plan, todos);
}

/** Move one task to status with observed evidence; runId selects the run current binding. */
export async function setTodoOutcome(
  store: Store,
  agentId: string,
  conversationId: string,
  todoId: string,
  status: 'pending' | 'blocked',
  note: string,
  evidence: TodoEvidence,
  planId?: string,
  runId?: string,
): Promise<TaskPlan | null> {
  const plan = await planForTarget(store, agentId, conversationId, planId, runId);
  if (plan === null) return null;
  if (!plan.todos.some((todo) => todo.id === todoId)) return plan;
  const todos = plan.todos.map((todo) => (todo.id === todoId ? { ...todo, status, note, evidence } : todo));
  return putPlan(store, agentId, conversationId, plan, todos);
}

/** Record completion-hook evidence; runId selects the run current binding. */
export async function setTodoEvidence(
  store: Store,
  agentId: string,
  conversationId: string,
  todoId: string,
  evidence: TodoEvidence,
  planId?: string,
  runId?: string,
): Promise<TaskPlan | null> {
  const plan = await planForTarget(store, agentId, conversationId, planId, runId);
  if (plan === null) return null;
  if (!plan.todos.some((todo) => todo.id === todoId)) return plan;
  const todos = plan.todos.map((todo) => (todo.id === todoId ? { ...todo, evidence } : todo));
  return putPlan(store, agentId, conversationId, plan, todos);
}

async function putPlan(store: Store, agentId: string, conversationId: string, plan: TaskPlan, todos: Todo[]): Promise<TaskPlan> {
  const next: TaskPlan = { ...plan, todos, at: new Date().toISOString() };
  await store.put('items', next, { conversationId, agentId, runId: plan.runId });
  await store.emit({ type: 'item.added', conversationId, item: next });
  await emitAgentStatus(store, agentId);
  return next;
}
