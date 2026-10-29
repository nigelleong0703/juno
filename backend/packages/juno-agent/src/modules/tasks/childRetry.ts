/**
 * Operational retry for a pending reserved child (PH12).
 *
 * Same-step replays resolve the same row by deterministic id, but a LATER model step gets a NEW
 * step id and would mint a new child, orphaning the pending one. This helper redelivers the SAME
 * reserved workflow key from a later turn or restart via an explicit retryRunId bound to the own
 * parent: no new reserve, no concurrency/budget precheck, no settings reread. Same-parent spawns are
 * serialized by the parent Restate actor; no generic DB concurrency guarantee is claimed here.
 */
import type { Store } from '../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { appendToTranscript, readTranscript } from '../../execution/brain/transcript.js';
import { readLatestCompaction } from '../../execution/brain/compaction.js';
import { projectMessages } from '../../execution/brain/context.js';
import { isSystemEntry } from '../../execution/brain/context-notes.js';
import { childPlanId, childSessionKey, depthOf, isTerminal, toStatus, type ChildRun, type ChildStatus } from './childRead.js';
import type { Run } from '@agent-desktop/public-contracts';
import type { ChildDispatchAdapter, ChildSpawnInput, ChildSpawnOutcome } from './child.js';
/** A run row counts as terminal for redelivery: never resurrect a stopped/failed/completed row. */
function isTerminalRow(row: Run): boolean {
  return isTerminal(row.status);
}
/** A retry resolves the same reservation only: target, parent, session and plan must all match. */
export function isSameReservation(row: ChildRun, input: { agentId: string; conversationId: string; sessionKey: string; planId: string; parentRunId: string }): boolean {
  return row.agentId === input.agentId && row.conversationId === input.conversationId && row.childSessionKey === input.sessionKey && row.planId === input.planId && row.parentRunId === input.parentRunId;
}
/**
 * Record delivery state with a narrow patch (dispatch fields only): a full-document put here could
 * clobber a live child that already started (running status, usage) with our stale queued copy.
 */
/**
 * Record delivery state with a narrow patch (dispatch fields only): a full-document put here could
 * clobber a live child that already started (running status, usage) with our stale queued copy.
 * Throws when the write fails: callers translate that into a retryable outcome, never a false ok.
 */
export async function markDispatch(store: Store, runId: string, patch: { dispatch: 'pending' | 'accepted'; dispatchError?: string }): Promise<void> {
  const update: Partial<ChildRun> = { ...patch };
  await store.patch('runs', runId, update);
}
/**
 * A child starts with a copy of what it continues: a continuation copies the earlier child's transcript, a new
 * child copies its parent's conversation as the parent's own model call sees it (checkpoint + later rows, no
 * system row), minus any tool call that has no result yet (the child_spawn call itself). Rows get ids derived
 * from the new run id, so a replayed dispatch rewrites the same rows instead of copying twice.
 */
export async function seedContinuation(store: Store, row: ChildRun): Promise<void> {
  if (row.childSessionKey === undefined) return;
  let messages: Message[];
  if (row.continues !== undefined) {
    messages = (await readTranscript(store, childSessionKey(row.agentId, row.conversationId ?? '', row.continues))).map((entry) => entry.message as Message);
  } else {
    const parent: ChildRun | null = row.parentRunId === undefined ? null : await store.get('runs', row.parentRunId);
    if (parent === null) return;
    const parentKey = parent.childSessionKey ?? parent.agentId + ':' + parent.conversationId;
    const entries = (await readTranscript(store, parentKey)).filter((entry) => !isSystemEntry(entry));
    messages = withoutOpenToolCalls(projectMessages(entries, await readLatestCompaction(store, parentKey), true));
  }
  if (messages.length === 0) return;
  await appendToTranscript(store, row.childSessionKey, messages, row.id);
}

/** Drop assistant messages that call a tool nobody answered yet, and results whose call is gone. */
export function withoutOpenToolCalls(messages: Message[]): Message[] {
  const answered = new Set(messages.flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : [])));
  const kept = messages.filter((m) => m.role !== 'assistant' || m.content.every((block) => block.type !== 'toolCall' || answered.has(block.id)));
  const called = new Set(kept.flatMap((m) => (m.role === 'assistant' ? m.content.flatMap((block) => (block.type === 'toolCall' ? [block.id] : [])) : [])));
  return kept.filter((m) => m.role !== 'toolResult' || called.has(m.toolCallId));
}

export async function retryReservedChild(store: Store, adapter: ChildDispatchAdapter | undefined, input: ChildSpawnInput, signal?: AbortSignal): Promise<ChildSpawnOutcome> {
  if (signal?.aborted) return { ok: false, reason: 'run_stopped' };
  if (adapter === undefined) return { ok: false, reason: 'dispatch_unavailable' };
  const runId = input.retryRunId ?? '';
  if (runId === '') return { ok: false, reason: 'parent_not_found' };
  const row: ChildRun | null = await store.get('runs', runId);
  if (row === null || row.parentRunId !== input.parentRunId) return { ok: false, reason: 'parent_not_found' };
  if (row.conversationId !== input.conversationId) return { ok: false, reason: 'parent_conversation_mismatch' };
  if (row.agentId !== input.targetAgentId) return { ok: false, reason: 'target_not_authorized' };
  if (isTerminalRow(row)) return { ok: false, reason: 'parent_terminal' };
  if (row.dispatch === 'accepted') return { ok: true, child: await toStatus(store, row) };
  const parent: ChildRun | null = await store.get('runs', input.parentRunId);
  if (parent === null) return { ok: false, reason: 'parent_not_found' };
  if (isTerminalRow(parent)) return { ok: false, reason: 'parent_terminal' };
  const depth = await depthOf(store, input.parentRunId);
  const storedPrompt = typeof row.childPrompt === 'string' && row.childPrompt.length > 0 ? row.childPrompt : input.prompt.trim();
  const sessionKey = childSessionKey(row.agentId, input.conversationId, runId);
  if (row.childSessionKey !== sessionKey || row.planId !== childPlanId(row.agentId, input.conversationId, runId)) {
    return { ok: false, reason: 'target_not_authorized' };
  }
  try {
    await seedContinuation(store, row);
    await adapter.startChildRun({ runId, ownerId: input.ownerId, agentId: row.agentId, conversationId: input.conversationId, sessionKey, planId: String(row.planId), parentRunId: input.parentRunId, prompt: storedPrompt, depth: depth + 1 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await markDispatch(store, runId, { dispatch: 'pending', dispatchError: message });
    } catch {
      // The row keeps its prior state; the outcome below stays retryable via the same workflow key.
    }
    return { ok: false, reason: 'dispatch_failed', runId };
  }
  try {
    await markDispatch(store, runId, { dispatch: 'accepted' });
  } catch {
    // Delivered but unrecorded: same-key redelivery is idempotent, so report retryable, never ok.
    return { ok: false, reason: 'dispatch_failed', runId };
  }
  const current: ChildRun | null = await store.get('runs', runId);
  if (current === null) return { ok: false, reason: 'parent_not_found' };
  const status: ChildStatus = await toStatus(store, current);
  return { ok: true, child: status };
}
