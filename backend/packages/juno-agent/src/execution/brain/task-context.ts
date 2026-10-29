/**
 * The authoritative task section of the system prompt.
 *
 * Built from the canonical plan item for this agent+conversation (see modules/tasks/state), never from
 * the transcript, so compaction and run boundaries cannot drop or duplicate the task list. Rendered as
 * quoted untrusted data like every other section; an unreadable plan renders an explicit marker instead
 * of silently looking like "no tasks".
 */
import type { Store } from '../../contracts/index.js';
import type { Todo } from '@agent-desktop/public-contracts';
import { harnessText } from '../../modules/harness/loader.js';
import { readTaskPlan, type TaskPlan } from '../../modules/tasks/state.js';
import { childPlanFor, readRunBinding } from '../../modules/tasks/plan-binding.js';

function renderTodo(todo: Todo): string {
  const note = todo.status === 'blocked' && todo.note ? ' — ' + todo.note : '';
  return '- [' + todo.status + '] ' + JSON.stringify(todo.text) + ' (id: ' + todo.id + ')' + note;
}

function unreadable(reason: string): string {
  return harnessText('tasks.unreadable', { reason });
}

function renderPlan(plan: TaskPlan): string {
  if (plan.todos.length === 0) return '';
  const open = plan.todos.filter((todo) => todo.status !== 'done').length;
  return (
    harnessText('tasks.header') + '\n' +
    harnessText('tasks.open_count', { open: String(open), total: String(plan.todos.length) }) + '\n' +
    plan.todos.map(renderTodo).join('\n')
  );
}

/** The `## Current tasks` section, or an empty string when the run has no plan. */
export async function buildTaskSection(store: Store, agentId: string, conversationId: string, sessionKey?: string): Promise<string> {
  const childRunId = parseChildRunId(agentId, conversationId, sessionKey);
  if (childRunId === undefined) {
    let plan: TaskPlan | null;
    try {
      plan = await readTaskPlan(store, agentId, conversationId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return unreadable(reason);
    }
    if (plan === null) return '';
    return renderPlan(plan);
  }
  if (childRunId.length === 0) return unreadable(harnessText('tasks.child_binding_malformed'));
  try {
    const binding = await readRunBinding(store, agentId, conversationId, childRunId);
    if (binding.scope !== 'child' || binding.parentRunId === undefined) {
      return unreadable(harnessText('tasks.child_binding_unreadable', { runId: childRunId }));
    }
    const plan = await childPlanFor(store, binding.planId, agentId, conversationId, childRunId, binding.parentRunId);
    if (plan === null) return '';
    return renderPlan(plan);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return unreadable(reason);
  }
}

/**
 * The child run id when sessionKey claims child scope, undefined for root scope,
 * empty string for a malformed or foreign child binding (fail closed, never root fallback).
 */
function parseChildRunId(agentId: string, conversationId: string, sessionKey: string | undefined): string | undefined {
  const root = agentId + ':' + conversationId;
  if (sessionKey === undefined || sessionKey === root) return undefined;
  if (!sessionKey.includes('::child:')) return undefined;
  const prefix = root + '::child:';
  if (!sessionKey.startsWith(prefix)) return '';
  return sessionKey.slice(prefix.length);
}
