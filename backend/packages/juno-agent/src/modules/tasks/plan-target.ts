/**
 * Write-side plan resolution (PH12 namespace).
 *
 * Narrows stored docs to plans without casts and resolves the plan a setter targets: the
 * run current binding when a runId is given, else the explicit plan id in its own scope.
 * A malformed child binding resolves to null so setters refuse without touching the root.
 */
import type { Store } from '../../contracts/index.js';
import { planItemSchema } from '@agent-desktop/public-contracts';
import { canonicalPlanId, isChildPlan, readTaskPlan, type TaskPlan } from './state.js';
import { childPlanFor, readRunBinding } from './plan-binding.js';

export function isTaskPlan(doc: unknown): doc is TaskPlan {
  if (typeof doc !== 'object' || doc === null) return false;
  if (!('type' in doc) || doc.type !== 'plan') return false;
  if (!('id' in doc) || typeof doc.id !== 'string') return false;
  if (!('conversationId' in doc) || typeof doc.conversationId !== 'string') return false;
  if (!('todos' in doc) || !Array.isArray(doc.todos)) return false;
  return planItemSchema.safeParse(doc).success;
}

export function asPlan(doc: unknown): TaskPlan | null {
  return isTaskPlan(doc) ? doc : null;
}

/** The stored plan for an explicit planId, accepted only in its own agent and conversation scope. */
export async function planAt(store: Store, agentId: string, conversationId: string, planId?: string): Promise<TaskPlan | null> {
  if (planId === undefined) return readTaskPlan(store, agentId, conversationId);
  const plan = asPlan(await store.get('items', planId));
  if (plan === null) return null;
  if (plan.agentId !== agentId || plan.conversationId !== conversationId) return null;
  if (planId !== canonicalPlanId(agentId, conversationId) && !isChildPlan(plan)) return null;
  return plan;
}

/** The stored plan for the run current binding; null when absent or malformed, never the root fallback for a child. */
export async function planForRun(store: Store, agentId: string, conversationId: string, runId: string): Promise<TaskPlan | null> {
  let binding;
  try {
    binding = await readRunBinding(store, agentId, conversationId, runId);
  } catch {
    return null;
  }
  if (binding.scope === 'child') {
    if (binding.parentRunId === undefined) return null;
    return childPlanFor(store, binding.planId, agentId, conversationId, runId, binding.parentRunId);
  }
  return readTaskPlan(store, agentId, conversationId);
}

export async function planForTarget(
  store: Store,
  agentId: string,
  conversationId: string,
  planId?: string,
  runId?: string,
): Promise<TaskPlan | null> {
  if (runId !== undefined) return planForRun(store, agentId, conversationId, runId);
  return planAt(store, agentId, conversationId, planId);
}
