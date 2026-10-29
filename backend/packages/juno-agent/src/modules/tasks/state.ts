/**
 * Persistent task-plan reads (GC12).
 *
 * A task belongs to an agent+conversation across execution runs. Plan items already persist todos,
 * so one canonical plan per agent+conversation replaces the old append-only accidental snapshots;
 * no new DB table is added. The canonical plan carries its owning agentId; legacy plans omit it
 * and are attributed only through the authoritative run.agentId, never text or conversation
 * membership, so a foreign agent plan never bleeds into this agent tasks.
 *
 * Reads run through the caller owner-scoped store: a missing plan is null, while an unreadable or
 * non-advancing store throws so a failed read is never mistaken for no outstanding tasks. The
 * writes live in ./plan-write.ts and the child binding in ./plan-binding.ts, so each file stays
 * small enough to review.
 */
import type { Store } from '../../contracts/index.js';
import type { Item, Todo, TodoCheck } from '@agent-desktop/public-contracts';
import { z } from 'zod';

const planMetaSchema = z.object({
  scope: z.enum(['root', 'child']).optional(),
  parentRunId: z.string().min(1).optional(),
}).passthrough();

export function isChildPlan(doc: unknown): boolean {
  const meta = planMetaSchema.safeParse(doc);
  return meta.success && meta.data.scope === 'child';
}

export type TaskPlan = Extract<Item, { type: 'plan' }>;

/** A todo from the model: an omitted status/note preserves the existing entry when merging by id. */
export interface TodoDraft {
  id: string;
  text: string;
  status?: Todo['status'];
  note?: string;
  evidence?: Todo['evidence'];
}

const SCAN_LIMIT = 200;
const SCAN_MAX_PAGES = 50;

/** Collision-free stable id for one agent+conversation pair. */
export function canonicalPlanId(agentId: string, conversationId: string): string {
  const pair = Buffer.from(JSON.stringify([agentId, conversationId]), 'utf8').toString('base64url');
  return 'plan-' + pair;
}

/** Plan items, following cursors; a stuck cursor or page cap fails visibly. */
async function scanPlanItems(store: Store, conversationId?: string): Promise<TaskPlan[]> {
  const plans: TaskPlan[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const result = await store.list('items', {
      limit: SCAN_LIMIT,
      cursor,
      ...(conversationId ? { where: { conversationId } } : {}),
    });
    for (const item of result.items) if (item.type === 'plan') plans.push(item);
    if (!result.nextCursor) return plans;
    if (result.nextCursor === cursor) throw new Error('items pagination cursor did not advance');
    cursor = result.nextCursor;
  }
  throw new Error('plan scan exceeded ' + SCAN_MAX_PAGES + ' pages');
}

function newest(plans: TaskPlan[]): TaskPlan | undefined {
  return plans.reduce<TaskPlan | undefined>((best, plan) => (!best || plan.at >= best.at ? plan : best), undefined);
}

/** Legacy plans attributed to this agent through the bound run, with agentId filled in. */
async function legacyForAgent(store: Store, plans: TaskPlan[], agentId: string): Promise<TaskPlan[]> {
  const resolved: TaskPlan[] = [];
  for (const plan of plans) {
    const run = await store.get('runs', plan.runId);
    if (run?.agentId === agentId) resolved.push({ ...plan, agentId });
  }
  return resolved;
}

/** The canonical plan doc for the exact pair, validated so a same-id doc cannot impersonate it. */
async function directCanonical(store: Store, agentId: string, conversationId: string): Promise<TaskPlan | null> {
  const plan = await store.get('items', canonicalPlanId(agentId, conversationId));
  if (!plan || plan.type !== 'plan') return null;
  if (plan.agentId !== agentId || plan.conversationId !== conversationId) return null;
  return plan;
}

/**
 * The effective root plan for this agent+conversation: the canonical plan, else the newest
 * legacy plan whose bound run.agentId equals agentId. The stored runId is only the last
 * writer, never a scope gate, so the root persists across runs. Null when the agent has none.
 */
export async function readTaskPlan(store: Store, agentId: string, conversationId: string): Promise<TaskPlan | null> {
  const canonical = await directCanonical(store, agentId, conversationId);
  if (canonical) return canonical;
  const legacy = (await scanPlanItems(store, conversationId)).filter(
    (plan) => plan.agentId === undefined && plan.conversationId === conversationId && !isChildPlan(plan),
  );
  if (legacy.length === 0) return null;
  return newest(await legacyForAgent(store, legacy, agentId)) ?? null;
}

/**
 * The newest root plan per conversation plus every owned child scope as its own entry, newest
 * first. A child plan is never folded into the conversation root: dropping it would hide work
 * the child run actually owns.
 */
export async function listTaskPlans(store: Store, agentId: string): Promise<TaskPlan[]> {
  const plans = await scanPlanItems(store);
  const byConversation = new Map<string, TaskPlan>();
  const own = plans.filter((entry) => entry.agentId === agentId);
  for (const plan of own.filter((entry) => !isChildPlan(entry))) {
    const current = byConversation.get(plan.conversationId);
    byConversation.set(plan.conversationId, current ? newest([current, plan]) ?? plan : plan);
  }
  const legacy = await legacyForAgent(
    store,
    plans.filter((entry) => entry.agentId === undefined && !isChildPlan(entry)),
    agentId,
  );
  const legacyByConversation = new Map<string, TaskPlan>();
  for (const plan of legacy) {
    const current = legacyByConversation.get(plan.conversationId);
    legacyByConversation.set(plan.conversationId, current ? newest([current, plan]) ?? plan : plan);
  }
  for (const [conversationId, plan] of legacyByConversation) {
    if (!byConversation.has(conversationId)) byConversation.set(conversationId, plan);
  }
  const children = own.filter((entry) => isChildPlan(entry));
  return [...byConversation.values(), ...children].sort((a, b) => b.at.localeCompare(a.at));
}

export function isOpen(todo: Todo): boolean {
  return todo.status === 'pending' || todo.status === 'in_progress';
}

/** Tasks that are marked done and carry configured checks the completion hook must still satisfy. */
export function checksToVerify(plan: TaskPlan): Array<{ todoId: string; checks: TodoCheck[] }> {
  return plan.todos
    .filter((todo) => todo.status === 'done' && (todo.checks?.length ?? 0) > 0)
    .map((todo) => ({ todoId: todo.id, checks: todo.checks ?? [] }));
}
