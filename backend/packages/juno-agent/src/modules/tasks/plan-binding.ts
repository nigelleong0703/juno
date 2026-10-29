/**
 * Canonical child plan binding (PH12 namespace).
 *
 * A child run is recognized by its stored run doc: a present parentRunId means child scope.
 * The child plan id and session derive from agent, conversation and child run, so a replay
 * resolves the same scope and nothing is invented at read time. A valid child never reads
 * the root plan: an absent child doc means own none, while a present but malformed doc throws
 * so the gate blocks unreadable fail-closed instead of completing as if there were no tasks.
 */
import type { Store } from '../../contracts/index.js';
import { z } from 'zod';
import { canonicalPlanId, isChildPlan, readTaskPlan, type TaskPlan } from './state.js';
import { childPlanId } from './childRead.js';
import { childSessionKey } from './child.js';

export interface PlanBinding {
  planId: string;
  rootPlanId: string;
  scope: 'root' | 'child';
  parentRunId?: string;
}

const planMetaSchema = z.object({
  scope: z.enum(['root', 'child']).optional(),
  parentRunId: z.string().min(1).optional(),
}).passthrough();

const storedRunSchema = z.object({
  parentRunId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  childSessionKey: z.string().min(1).optional(),
}).passthrough();

/**
 * The stored child plan this run owns. An absent doc is the legitimate empty child (null, own
 * none). A present doc with the wrong scope, owners, run or parent throws unreadable so the
 * caller blocks fail-closed instead of pretending the child has no tasks.
 */
export async function childPlanFor(
  store: Store,
  planId: string,
  agentId: string,
  conversationId: string,
  childRunId: string,
  parentRunId: string,
): Promise<TaskPlan | null> {
  const doc = await store.get('items', planId);
  if (doc === null) return null;
  if (doc.type !== 'plan') throw new Error('child plan unreadable for run ' + childRunId);
  if (!isChildPlan(doc)) throw new Error('child plan scope mismatch for run ' + childRunId);
  if (doc.agentId !== agentId) throw new Error('child plan agent mismatch for run ' + childRunId);
  if (doc.conversationId !== conversationId) throw new Error('child plan conversation mismatch for run ' + childRunId);
  if (doc.runId !== childRunId) throw new Error('child plan run mismatch for run ' + childRunId);
  const meta = planMetaSchema.safeParse(doc);
  if (!meta.success) throw new Error('child plan metadata unreadable for run ' + childRunId);
  if (meta.data.parentRunId !== parentRunId) throw new Error('child plan parent mismatch for run ' + childRunId);
  return doc;
}

/**
 * Resolve the plan binding for one run from its canonical stored run doc. A run without a
 * parentRunId is a root run. A child run requires its stored agent, conversation, derived plan
 * id and session to match exactly, plus the actual parent link in the same conversation; any
 * mismatch throws so the caller never touches the root scope.
 */
export async function readRunBinding(
  store: Store,
  agentId: string,
  conversationId: string,
  runId: string,
): Promise<PlanBinding> {
  const rootPlanId = canonicalPlanId(agentId, conversationId);
  if (runId.length === 0) return { planId: rootPlanId, rootPlanId, scope: 'root' };
  const raw = await store.get('runs', runId);
  if (raw === null) return { planId: rootPlanId, rootPlanId, scope: 'root' };
  const parsed = storedRunSchema.safeParse(raw);
  if (!parsed.success) throw new Error('child run binding unreadable for run ' + runId);
  if (parsed.data.parentRunId === undefined) return { planId: rootPlanId, rootPlanId, scope: 'root' };
  const parentRunId = parsed.data.parentRunId;
  if (parsed.data.agentId !== agentId) throw new Error('child run agent mismatch for run ' + runId);
  if (parsed.data.conversationId !== conversationId) throw new Error('child run conversation mismatch for run ' + runId);
  const expectedPlanId = childPlanId(agentId, conversationId, runId);
  if (parsed.data.planId !== expectedPlanId) throw new Error('child run plan mismatch for run ' + runId);
  const expectedSession = childSessionKey(agentId, conversationId, runId);
  if (parsed.data.childSessionKey !== expectedSession) throw new Error('child run session mismatch for run ' + runId);
  const parentRaw = await store.get('runs', parentRunId);
  if (parentRaw === null) throw new Error('child parent run missing for run ' + runId);
  const parentParsed = storedRunSchema.safeParse(parentRaw);
  if (!parentParsed.success) throw new Error('child parent run unreadable for run ' + runId);
  if (parentParsed.data.conversationId !== conversationId) throw new Error('child parent conversation mismatch for run ' + runId);
  return { planId: expectedPlanId, rootPlanId, scope: 'child', parentRunId };
}

/**
 * The plan doc for a binding. A child scope returns its own child plan or null when absent;
 * it never falls back to the root plan, so child work stays independent of parent tasks.
 * A present but malformed child doc throws, so the gate blocks instead of completing.
 */
export async function readBoundTaskPlan(
  store: Store,
  agentId: string,
  conversationId: string,
  runId: string,
): Promise<TaskPlan | null> {
  const binding = await readRunBinding(store, agentId, conversationId, runId);
  if (binding.scope === 'child') {
    if (binding.parentRunId === undefined) throw new Error('child binding missing parent for run ' + runId);
    return childPlanFor(store, binding.planId, agentId, conversationId, runId, binding.parentRunId);
  }
  return readTaskPlan(store, agentId, conversationId);
}
