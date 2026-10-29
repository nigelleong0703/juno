/**
 * GC13 runtime todo hooks.
 *
 * The authoritative task state for one run is its bound plan: a child run reads only its own
 * child scope, a root run reads the agent+conversation root. A missing child plan means no tasks
 * and may finish even while the parent root stays pending; an unreadable binding never may and
 * blocks fail-closed. Callers read inside a durable step because the plan is shared mutable state.
 */
import type { Store } from '../../../contracts/index.js';
import type { Todo } from '@agent-desktop/public-contracts';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { TaskPlan } from '../../../modules/tasks/state.js';
import { readBoundTaskPlan } from '../../../modules/tasks/plan-binding.js';
import { blockOpenTasks } from '../../../modules/tasks/plan-updates.js';
import { harnessText } from '../../../modules/harness/loader.js';

export { checksToVerify } from '../../../modules/tasks/state.js';
export { readRunBinding, readBoundTaskPlan } from '../../../modules/tasks/plan-binding.js';
export { blockOpenTasks, setTodoChecks, setTodoEvidence, setTodoOutcome } from '../../../modules/tasks/plan-updates.js';

/** Failed configured checks before the run blocks instead of looping forever on the same evidence. */
export const MAX_VERIFICATION_ATTEMPTS = 2;

/** Consecutive model final turns, with no plan movement and no tool run, before the run blocks. */
export const MAX_UNCHANGED_FINALS = 3;

export type RunTaskState =
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'plan'; plan: TaskPlan };

export type BlockCause = 'unreadable' | 'stalled' | 'limit' | 'waiting';

/** Read the plan this run is bound to, separating no tasks from could not read the tasks. */
export async function readRunTasks(
  store: Store,
  agentId: string,
  conversationId: string,
  runId?: string,
): Promise<RunTaskState> {
  try {
    const plan = runId === undefined
      ? await readBoundTaskPlan(store, agentId, conversationId, '')
      : await readBoundTaskPlan(store, agentId, conversationId, runId);
    return plan === null ? { kind: 'none' } : { kind: 'plan', plan };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function isOpen(todo: Todo): boolean {
  return todo.status === 'pending' || todo.status === 'in_progress';
}

export function openTodos(state: RunTaskState): Todo[] {
  return state.kind === 'plan' ? state.plan.todos.filter(isOpen) : [];
}

export function blockedTodos(state: RunTaskState): Todo[] {
  return state.kind === 'plan' ? state.plan.todos.filter((todo) => todo.status === 'blocked') : [];
}

export function planSignature(state: RunTaskState): string {
  if (state.kind !== 'plan') return '';
  return state.plan.todos
    .map((todo) => [todo.id, todo.text, todo.status, todo.note ?? ''].join('\u0001'))
    .join('|');
}

function describeForModel(todos: Todo[]): string {
  return todos.map((todo) => todo.id + ' ' + JSON.stringify(todo.text) + ' (' + todo.status + ')').join(', ');
}

function describeForUser(todos: Todo[]): string {
  return todos
    .map((todo) => JSON.stringify(todo.text) + (todo.note ? ' - ' + todo.note : ''))
    .join(', ');
}

export function continueHint(state: RunTaskState): string {
  const open = openTodos(state);
  if (open.length === 0) return '';
  return harnessText('hook.continue', { open: describeForModel(open) });
}

export function reconcileHint(state: RunTaskState): string {
  const open = openTodos(state);
  const blocked = blockedTodos(state);
  if (open.length === 0 && blocked.length === 0) return '';
  if (open.length > 0 && blocked.length > 0) return harnessText('hook.reconcile_both', { open: describeForModel(open), blocked: describeForModel(blocked) });
  if (open.length > 0) return harnessText('hook.reconcile_open', { open: describeForModel(open) });
  return harnessText('hook.reconcile_blocked', { blocked: describeForModel(blocked) });
}

/**
 * Said once at the start of a root run that something new woke (the owner wrote, a request was answered, a
 * background task reported): tasks left blocked on input are not dead, the new message may be the input.
 * The run, not a separate waiting loop, acts on it: resume the task, pass it to the child that waits, or
 * leave it blocked and say what is still missing.
 */
export function blockedInputHint(state: RunTaskState): string {
  const blocked = blockedTodos(state);
  if (blocked.length === 0) return '';
  return harnessText('hook.blocked_input', { blocked: blocked.map((todo) => todo.id + ' ' + JSON.stringify(todo.text) + (todo.note ? ' (' + todo.note + ')' : '')).join(', ') });
}

export function taskHintMessage(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() };
}

export function verificationHint(state: RunTaskState, failedTodoIds: readonly string[], note: string): string {
  const named = state.kind === 'plan'
    ? state.plan.todos
        .filter((todo) => failedTodoIds.includes(todo.id))
        .map((todo) => todo.id + ' ' + JSON.stringify(todo.text))
        .join(', ')
    : failedTodoIds.join(', ');
  return harnessText('hook.verification', { note, named });
}

export function verificationBlockedReason(note: string): string {
  return 'run blocked: configured completion checks did not pass (' + note + ')';
}

export function blockedReason(state: RunTaskState, cause: BlockCause): string {
  if (state.kind === 'unreadable') return 'run blocked: task state unreadable (' + state.reason + ')';
  const open = openTodos(state);
  if (open.length > 0) {
    const lead = cause === 'limit' ? 'step limit reached with ' : 'no progress on ';
    return 'run blocked: ' + lead + open.length + ' open task(s): ' + describeForUser(open);
  }
  const blocked = blockedTodos(state);
  if (blocked.length > 0) return 'run blocked: tasks need input: ' + describeForUser(blocked);
  return 'run blocked: no actionable task state';
}

/** Mark the run own outstanding tasks blocked; runId targets the run current binding for Dalton core. */
export async function blockRunTasks(
  store: Store,
  agentId: string,
  conversationId: string,
  reason: string,
  runId?: string,
): Promise<void> {
  const note = reason.trim();
  if (note.length === 0) return;
  try {
    await blockOpenTasks(store, agentId, conversationId, note, runId);
  } catch { // Unreadable plan: nothing to mark, and no task may be silently treated as done.
  }
}
