/**
 * Scoped child tasks (PH12) — admission, dispatch and cancellation.
 *
 * A child is a real run in the PARENT'S OWN conversation (never a hidden one) for an explicitly named
 * TARGET agent that is a member of that conversation and belongs to the caller's owner. The child owns
 * its OWN plan (childPlanId) so the child's completion gate can never see the parent's open tasks.
 * Admission is deterministic (owner|parent|step) with a fresh parent merge, and the dispatch is
 * idempotent on the SAME reserved workflow key. Same-step replays resolve the same row, but a later
 * model step gets a NEW step id, so operational retry uses an explicit retryRunId bound to the own
 * parent (no new reserve, slots, budget or settings reread). Same-parent spawns are serialized by the
 * parent Restate actor; no generic DB concurrency guarantee is claimed here.
 */
import { LIMITS } from '../../contracts/index.js';
import type { Store } from '../../contracts/index.js';
import type { Conversation } from '@agent-desktop/public-contracts';
import { depthOf, isTerminal, listChildTasks, readChildTask, toStatus, type ChildRun, type ChildStatus } from './childRead.js';
import { budgetViewWithChildren, inheritBudgetSnapshot, isChildBudgetSpent, isExecutionBudgetCorrupt } from './child-budget.js';

import { childPlanId, childRunId, childSessionKey } from './childRead.js';
export { isTerminal, listChildTasks, readChildTask, childPlanId, childRunId, childSessionKey } from './childRead.js';
import { isSameReservation, markDispatch, retryReservedChild, seedContinuation } from './childRetry.js';
import { backgroundCapRefusal, type BackgroundSpawn } from './child-background.js';
import { emitRunTask } from './agent-tasks.js';
import { recordRunStop } from './stop-record.js';
export type { ChildRun, ChildStatus } from './childRead.js';

/** Default for how many child tasks one parent run may have running at once; the spawning agent's maxSubTasks replaces it. */
export const CHILD_CONCURRENCY_LIMIT = 4;
export const CHILD_PROMPT_MAX_CHARS = 4_000;

/** The core's run entry: it starts the EXACT reserved run id (never a fresh random one). */
export interface ChildDispatchAdapter {
  startChildRun(input: { runId: string; ownerId: string; agentId: string; conversationId: string; sessionKey: string; planId: string; parentRunId: string; prompt: string; depth: number }): Promise<void>;
}

export type ChildRefusalReason =
  | 'parent_not_found' | 'owner_mismatch' | 'parent_conversation_mismatch' | 'target_not_authorized'
  | 'depth_exceeded' | 'concurrency_exceeded' | 'budget_exhausted' | 'invalid_prompt'
  | 'dispatch_unavailable' | 'dispatch_failed' | 'parent_terminal' | 'background_limit' | 'run_stopped';

export interface ChildSpawnInput {
  ownerId: string;
  /** The CALLING agent (the parent run's agent). */
  agentId: string;
  parentRunId: string;
  /** Must be the parent run's own conversation: a child never gets a hidden one. */
  conversationId: string;
  /** The durable step this spawn belongs to: it makes the child id deterministic and replay-safe. */
  callId: string;
  prompt: string;
  /** The parent's short imperative title for the user's task list; defaults to the start of the prompt. */
  title?: string;
  /** The agent that will actually run the child; it must be a member of the conversation. */
  targetAgentId: string;
  /**
   * Operational retry of a pending reservation from a LATER step (a new step id would otherwise
   * mint a new child and orphan the pending one). Must name a row reserved by this same parent;
   * a foreign or mismatched row is refused without being read out.
   */
  retryRunId?: string;
  /** Background mode (H-69/H-70): the child reports its end to this session instead of being awaited. */
  notify?: BackgroundSpawn;
  /** child_message on a finished child: the earlier run this one continues (its transcript is seeded from it). */
  continuesRunId?: string;
  /** child_spawn `tools`: the child may only call these names (narrowing; enforced at the tool policy). */
  tools?: string[];
  /** child_spawn `fast`: run the child on the fast model (owner's, else the platform's, else the normal one). */
  fast?: boolean;
  /** child_spawn `deep`: run the child at the deep reasoning tier (slower, thinks more). */
  deep?: boolean;
  /**
   * Private feed-card origin, set by the child_spawn tool only when the spawning
   * run was directly card-eligible (a user message in this chat). Stored on the
   * child row; never a public control and never taken from model arguments.
   */
  feedCardUserOrigin?: true;
}

export type ChildSpawnOutcome = { ok: true; child: ChildStatus } | { ok: false; reason: ChildRefusalReason; runId?: string };



function ownerOf(doc: unknown): string | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined;
  const created = Reflect.get(doc, 'createdBy');
  if (typeof created === 'string' && created.length > 0) return created;
  const owner = Reflect.get(doc, 'ownerId');
  return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
}

export async function spawnChildTask(store: Store, input: ChildSpawnInput, adapter: ChildDispatchAdapter | undefined, signal?: AbortSignal): Promise<ChildSpawnOutcome> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0 || prompt.length > CHILD_PROMPT_MAX_CHARS) return { ok: false, reason: 'invalid_prompt' };
  if (adapter === undefined) return { ok: false, reason: 'dispatch_unavailable' };
  const parent: ChildRun | null = await store.get('runs', input.parentRunId);
  if (parent === null) return { ok: false, reason: 'parent_not_found' };
  if (parent.agentId !== input.agentId) return { ok: false, reason: 'owner_mismatch' };
  if (ownerOf(parent) !== undefined && ownerOf(parent) !== input.ownerId) return { ok: false, reason: 'owner_mismatch' };
  // The child lives in the PARENT's conversation, and the caller must name exactly that conversation.
  if (parent.conversationId !== input.conversationId) return { ok: false, reason: 'parent_conversation_mismatch' };
  // Real membership validation: the target agent exists in this owner's scope AND is in the conversation.
  const target = await store.get('agents', input.targetAgentId);
  const caller = await store.get('agents', input.agentId);
  if (target === null) return { ok: false, reason: 'target_not_authorized' };
  if (ownerOf(target) !== undefined && ownerOf(target) !== input.ownerId) return { ok: false, reason: 'target_not_authorized' };
  const conversation: Conversation | null = await store.get('conversations', input.conversationId);
  if (conversation === null || !conversation.agentIds.includes(input.targetAgentId)) return { ok: false, reason: 'target_not_authorized' };
  if (!conversation.agentIds.includes(input.agentId)) return { ok: false, reason: 'target_not_authorized' };

  // Operational retry from a later step: the SAME reserved row, key and task — no new reserve,
  // no concurrency/budget precheck, no settings reread. Anything not reserved by this parent is refused.
  if (input.retryRunId !== undefined) return retryReservedChild(store, adapter, input, signal);
  const runId = childRunId({ ownerId: input.ownerId, parentRunId: input.parentRunId, callId: input.callId });
  const sessionKey = childSessionKey(input.targetAgentId, input.conversationId, runId);
  const planId = childPlanId(input.targetAgentId, input.conversationId, runId);
  const depth = await depthOf(store, input.parentRunId);
  const dispatchInput = { runId, ownerId: input.ownerId, agentId: input.targetAgentId, conversationId: input.conversationId, sessionKey, planId, parentRunId: input.parentRunId, prompt, depth: depth + 1 };

  // A RETRY must be recognized BEFORE any budget/concurrency precheck (a full slot must not deny it).
  // The reserved row is stable: a retry re-sends the SAME workflow key and never rereads globals.
  const existing: ChildRun | null = await store.get('runs', runId);
  if (existing !== null) {
    if (!isSameReservation(existing, dispatchInput)) return { ok: false, reason: 'target_not_authorized' };
    if (existing.dispatch === 'accepted') return { ok: true, child: await toStatus(store, existing) };
    return dispatchChild(store, adapter, dispatchInput, existing);
  }

  if (depth >= LIMITS.chain.maxHopDepth) return { ok: false, reason: 'depth_exceeded' };
  if (input.notify !== undefined && (await backgroundCapRefusal(store, input.conversationId, input.notify)) !== undefined) return { ok: false, reason: 'background_limit' };
  if (isExecutionBudgetCorrupt(parent)) return { ok: false, reason: 'budget_exhausted' };
  const spent = await budgetViewWithChildren(store, parent, input.parentRunId);
  const snapshot = inheritBudgetSnapshot(spent);
  if (isChildBudgetSpent(snapshot, spent)) return { ok: false, reason: 'budget_exhausted' };
  const active = (await listChildTasks(store, input.parentRunId)).filter((child) => !isTerminal(child.status)).length;
  if (active >= (caller?.maxSubTasks ?? CHILD_CONCURRENCY_LIMIT)) return { ok: false, reason: 'concurrency_exceeded' };
  if (signal?.aborted) return { ok: false, reason: 'run_stopped' };

  const at = new Date().toISOString();
  const child: ChildRun = {
    id: runId,
    agentId: input.targetAgentId,
    conversationId: input.conversationId,
    parentRunId: input.parentRunId,
    // Where this child sits in the task tree, written once here (BACKEND 6.5); everything below it copies the root.
    rootRunId: parent.rootRunId ?? parent.id,
    depth: depth + 1,
    // The same origin the run's first write records (run-engine newRun), set now so the queued child already reads as a task.
    origin: { type: 'parent_run', runId: input.parentRunId },
    rootOrigin: parent.rootOrigin ?? parent.origin ?? { type: 'system', wakeKind: 'child_task', label: 'parent run not found' },
    childSessionKey: sessionKey,
    planId,
    budgetSnapshot: snapshot,
    childPrompt: prompt,
    dispatch: 'pending',
    ...(input.continuesRunId === undefined ? {} : { continues: input.continuesRunId }),
    ...(input.tools === undefined ? {} : { allowedTools: input.tools }),
    ...(input.fast === true ? { fastModel: true as const } : {}),
    ...(input.deep === true ? { deepEffort: true as const } : {}),
    ...(input.feedCardUserOrigin === true ? { feedCardUserOrigin: true as const } : {}),
    title: input.title ?? prompt.slice(0, 80),
    status: 'queued',
    kind: 'background',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: at,
    lastActivityAt: at,
    ...(input.notify === undefined ? {} : { notifyParent: { ownerId: input.ownerId, agentId: input.agentId, conversationId: input.conversationId, ...input.notify } }),
  };
  const reserved = await store.tx(async (tx) => {
    const found = await tx.get('runs', runId);
    if (found !== null) return false;
    await tx.put('runs', child, { agentId: input.targetAgentId, conversationId: input.conversationId, runId, status: 'queued', kind: 'background' });
    // H-88: lock the parent row before reading its links, so concurrent spawns append in turn instead of
    // one overwriting the other's link (stores without row locks fall back to a plain read).
    const fresh = tx.getForUpdate === undefined ? await tx.get('runs', input.parentRunId) : await tx.getForUpdate('runs', input.parentRunId);
    const links = fresh?.childRunIds ?? [];
    await tx.patch('runs', input.parentRunId, { childRunIds: links.includes(runId) ? links : [...links, runId] });
    return true;
  });
  if (!reserved) {
    const current: ChildRun | null = await store.get('runs', runId);
    if (current === null) return { ok: false, reason: 'parent_not_found' };
    if (!isSameReservation(current, dispatchInput)) return { ok: false, reason: 'target_not_authorized' };
    return dispatchChild(store, adapter, dispatchInput, current);
  }
  if (signal?.aborted) {
    // A reserved child that will never be dispatched must not stay a queued phantom.
    await store.patch('runs', runId, { status: 'stopped', finishedAt: new Date().toISOString(), error: 'child run was not dispatched: the run was stopped' }).catch(() => undefined);
    return { ok: false, reason: 'run_stopped' };
  }
  await emitRunTask(store, child);
  return dispatchChild(store, adapter, dispatchInput, child);
}

/** Dispatch the reserved run id; a failure leaves the row 'pending' so a retry re-sends the SAME key. */
async function dispatchChild(
  store: Store,
  adapter: ChildDispatchAdapter,
  input: { runId: string; ownerId: string; agentId: string; conversationId: string; sessionKey: string; planId: string; parentRunId: string; prompt: string; depth: number },
  row: ChildRun,
): Promise<ChildSpawnOutcome> {
  try {
    await seedContinuation(store, row);
    await adapter.startChildRun(input);
  } catch (error) {
    // Delivery is ambiguous or failed: keep it pending and let a retry re-send the same workflow key.
    const message = error instanceof Error ? error.message : String(error);
    try {
      await markDispatch(store, input.runId, { dispatch: 'pending', dispatchError: message });
    } catch {
      // The row keeps its prior state; the outcome below stays retryable via the same workflow key.
    }
    return { ok: false, reason: 'dispatch_failed', runId: input.runId };
  }
  try {
    await markDispatch(store, input.runId, { dispatch: 'accepted' });
  } catch {
    // Delivered but unrecorded: same-key redelivery is idempotent, so report retryable, never ok.
    return { ok: false, reason: 'dispatch_failed', runId: input.runId };
  }
  return { ok: true, child: await toStatus(store, { ...row, dispatch: 'accepted' }) };
}


/** Stop each active child's REAL run; the run's own terminal state is authoritative (no patched status). */
export async function cancelChildTasks(store: Store, stop: (runId: string) => Promise<void>, parentRunId: string): Promise<{ cancelled: number }> {
  let cancelled = 0;
  // A parent the owner stopped passes that on; a parent that just ended on its own leaves its children stopped by the platform.
  const by = (await store.get('runs', parentRunId))?.stoppedBy ?? 'system';
  for (const child of await listChildTasks(store, parentRunId)) {
    if (isTerminal(child.status)) continue;
    await recordRunStop(store, child.runId, by);
    await stop(child.runId);
    cancelled += 1;
  }
  return { cancelled };
}
