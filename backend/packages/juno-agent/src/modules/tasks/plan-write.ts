/**
 * Task-plan writes (GC12).
 *
 * Configured checks and observed evidence belong to the account, not to a plan write. Every writer
 * here carries them over by id, so a model merge:false replacement, a rename to new ids, or an
 * empty list can never clear the evidence a task must satisfy; only the configuration route sets or
 * removes checks. Root reads live in ./state.ts, the child binding in ./plan-binding.ts, the
 * write-side resolution in ./plan-target.ts and the setters in ./plan-updates.ts.
 *
 * A child run writes only its own child scope: the first write creates the reserved child plan
 * with server-written scope and parent link, later writes merge into that same scope, and a
 * malformed binding refuses instead of touching the root plan.
 */
import type { Store } from '../../contracts/index.js';
import type { Todo } from '@agent-desktop/public-contracts';
import { canonicalPlanId, readTaskPlan, type TaskPlan, type TodoDraft } from './state.js';
import { childPlanFor, readRunBinding } from './plan-binding.js';
import { emitAgentStatus } from '../../execution/agent-status.js';
import { asPlan } from './plan-target.js';

export { blockOpenTasks, setTodoChecks, setTodoEvidence, setTodoOutcome } from './plan-updates.js';

type StoredPlan = TaskPlan & { scope?: 'child' | 'root'; parentRunId?: string };

/** Upsert the plan this run is bound to: its reserved child plan, else the agent+conversation root. */
export async function writeBoundTaskPlan(
  store: Store,
  agentId: string,
  conversationId: string,
  runId: string,
  drafts: TodoDraft[],
  merge: boolean,
): Promise<TaskPlan> {
  const binding = await readRunBinding(store, agentId, conversationId, runId);
  if (binding.scope === 'child') {
    if (binding.parentRunId === undefined) throw new Error('child binding missing parent for run ' + runId);
    return writeChildPlan(store, agentId, conversationId, runId, binding.parentRunId, binding.planId, drafts, merge);
  }
  return writeTaskPlan(store, agentId, conversationId, runId, drafts, merge);
}

/** Upsert the reserved child plan for one child run, creating it with its scope link on first write. */
async function writeChildPlan(
  store: Store,
  agentId: string,
  conversationId: string,
  childRunId: string,
  parentRunId: string,
  planId: string,
  drafts: TodoDraft[],
  merge: boolean,
): Promise<TaskPlan> {
  const existing = await childPlanFor(store, planId, agentId, conversationId, childRunId, parentRunId);
  const before = new Map((existing?.todos ?? []).map((todo) => [todo.id, todo]));
  const listed = existing !== null && merge ? mergeDrafts(existing.todos, drafts) : drafts.map((draft) => ({ status: 'pending' as const, ...draft }));
  const carried = listed.map((todo) => carryConfigured(todo, before.get(todo.id)));
  const todos = retainConfigured(carried, existing?.todos ?? []);
  const base: StoredPlan = {
    ...(existing ?? { id: planId, conversationId, agentId, type: 'plan' as const, runId: childRunId, todos: [], at: new Date().toISOString() }),
    id: planId,
    conversationId,
    agentId,
    type: 'plan',
    runId: childRunId,
    scope: 'child',
    parentRunId,
    todos,
    at: new Date().toISOString(),
  };
  await store.put('items', base, { conversationId, runId: childRunId, agentId });
  await store.emit({ type: 'item.added', conversationId, item: base });
  await emitAgentStatus(store, agentId);
  return base;
}

function mergeDrafts(existing: Todo[], drafts: TodoDraft[]): Todo[] {
  const result = existing.map((todo) => ({ ...todo }));
  const index = new Map(result.map((todo) => [todo.id, todo]));
  // The same goal sent again without its id (the model resent the whole list) updates it instead of a second copy.
  const sameText = (text: string) => text.trim().toLowerCase();
  const byText = new Map(result.map((todo) => [sameText(todo.text), todo]));
  for (const draft of drafts) {
    const current = index.get(draft.id) ?? byText.get(sameText(draft.text));
    if (!current) {
      const created: Todo = { id: draft.id, text: draft.text, status: draft.status ?? 'pending' };
      if (draft.note !== undefined) created.note = draft.note;
      if (draft.evidence !== undefined) created.evidence = draft.evidence;
      result.push(created);
      index.set(created.id, created);
      byText.set(sameText(created.text), created);
      continue;
    }
    current.text = draft.text;
    if (draft.status !== undefined) current.status = draft.status;
    if (draft.note !== undefined) current.note = draft.note;
    if (draft.evidence !== undefined) current.evidence = draft.evidence;
  }
  return result;
}

function carryConfigured(todo: Todo, current: Todo | undefined): Todo {
  if (current === undefined) return todo;
  const next: Todo = { ...todo };
  if (current.checks !== undefined) next.checks = current.checks;
  if (next.evidence === undefined && current.evidence !== undefined) next.evidence = current.evidence;
  return next;
}

function retainConfigured(listed: Todo[], existing: readonly Todo[]): Todo[] {
  const present = new Set(listed.map((todo) => todo.id));
  const retained = existing.filter((todo) => (todo.checks?.length ?? 0) > 0 && !present.has(todo.id));
  return retained.length === 0 ? listed : [...listed, ...retained.map((todo) => ({ ...todo }))];
}

/**
 * Upsert the canonical root plan for this agent+conversation. merge true preserves unmentioned
 * todos; merge:false replaces the scope, except tasks carrying configured checks are retained.
 * The stored runId is only the last writer, never a scope gate, so the root persists across runs.
 */
export async function writeTaskPlan(
  store: Store,
  agentId: string,
  conversationId: string,
  runId: string,
  drafts: TodoDraft[],
  merge: boolean,
  planId?: string,
): Promise<TaskPlan> {
  const targetId = planId ?? canonicalPlanId(agentId, conversationId);
  const existing = planId === undefined ? await readTaskPlan(store, agentId, conversationId) : asPlan(await store.get('items', planId));
  const before = new Map((existing?.todos ?? []).map((todo) => [todo.id, todo]));
  const listed = existing !== null && merge ? mergeDrafts(existing.todos, drafts) : drafts.map((draft) => ({ status: 'pending' as const, ...draft }));
  const carried = listed.map((todo) => carryConfigured(todo, before.get(todo.id)));
  const todos = retainConfigured(carried, existing?.todos ?? []);
  const plan: TaskPlan = {
    ...(existing ?? {}),
    id: targetId,
    conversationId,
    agentId,
    type: 'plan',
    runId,
    todos,
    at: new Date().toISOString(),
  };
  await store.put('items', plan, { conversationId, runId, agentId });
  await store.emit({ type: 'item.added', conversationId, item: plan });
  await emitAgentStatus(store, agentId);
  return plan;
}
