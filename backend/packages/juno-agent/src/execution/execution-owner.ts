/**
 * Background execution owner boundary (E66).
 *
 * Account HTTP enters the request owner scope once per request, but Restate handlers run on their own
 * async chains (and survive restarts), so a wake's owner has to be re-established for every handler.
 * The execution services capture the request-scoped store facade, so `inOwnerScope` re-entering the
 * scope is what makes every read, write and emitted event resolve to the validated owner instead of
 * the raw store's "unknown" default. A wake that names no owner (or two owners) is refused, never
 * defaulted.
 */
import { sessionKey, type Store, type WakeEvent } from '../contracts/index.js';
import { runWithOwner } from '../owner-context.js';

/** Enter the validated owner scope for one handler body; concurrent handlers stay apart. */
export function inOwnerScope<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  return runWithOwner(ownerId, fn);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Owner signal on a stored doc: the owner-scoped store's stamp, else the doc's `createdBy` (agents).
 * Absent for owner-less legacy rows, which callers must refuse rather than default.
 */
export function docOwner(doc: unknown): string | undefined {
  if (!isRecord(doc)) return undefined;
  for (const key of ['ownerId', 'createdBy']) {
    const value = doc[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export interface WakeTarget {
  agentId: string;
  conversationId: string;
  /**
   * The caller's own session key: the canonical root `${agentId}:${conversationId}` or the exact
   * reserved child session `${agentId}:${conversationId}::child:${childRunId}`. Anything else is refused.
   */
  sessionKey: string;
}
/** Marker separating a canonical child session from its root session. */
export const CHILD_SESSION_MARKER = '::child:';
/** The reserved child run id named by a canonical child session, or undefined for a root session. */
export function childRunIdOfSession(sessionKeyValue: string, agentId: string, conversationId: string): string | undefined {
  const prefix = sessionKey(agentId, conversationId) + CHILD_SESSION_MARKER;
  if (!sessionKeyValue.startsWith(prefix)) return undefined;
  const runId = sessionKeyValue.slice(prefix.length);
  return runId.length > 0 ? runId : undefined;
}

export interface WakeOwner {
  ownerId?: string;
  reason?: string;
}

function readId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Non-empty owner named by a wake, or undefined when it is missing or malformed (never throws). */
export function readWakeOwner(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  return readId(event['ownerId']);
}

/**
 * The single owner a wake batch may act for: a non-empty owner on the first event, the same owner on
 * every event, one agent/conversation for the batch, and the canonical session key. Anything else is
 * refused — a spoofed owner, a cross-owner batch or a mismatched session never becomes a run.
 */
export function resolveWakeOwner(events: readonly WakeEvent[], target: WakeTarget): WakeOwner {
  const first = events[0];
  if (first === undefined) return { reason: 'no_wake_event' };
  const owner = readWakeOwner(first);
  if (owner === undefined) return { reason: 'missing_owner' };
  const agentId = readId(target.agentId);
  const conversationId = readId(target.conversationId);
  if (agentId === undefined || conversationId === undefined) return { reason: 'invalid_target' };
  const expectedSession = sessionKey(agentId, conversationId);
  const childRunId = childRunIdOfSession(target.sessionKey, agentId, conversationId);
  const isChildSession = childRunId !== undefined;
  // Every transcript write, inbox drain and finish RPC derives from the caller's own session key, so
  // a non-canonical key would address a foreign session even when the wake events look correct.
  if (target.sessionKey !== expectedSession && !isChildSession) return { reason: 'session_key_mismatch' };
  for (const event of events) {
    if (readWakeOwner(event) !== owner) return { reason: 'mixed_owner_wake' };
    if (event.agentId !== agentId || event.conversationId !== conversationId) {
      return { reason: 'wake_target_mismatch' };
    }
    if (event.sessionKey !== target.sessionKey) return { reason: 'session_key_mismatch' };
    if (isChildSession && event.kind !== 'child_task') return { reason: 'wake_target_mismatch' };
    if (!isChildSession && event.kind === 'child_task') return { reason: 'wake_target_mismatch' };
  }
  return { ownerId: owner };
}

/** Admission refusal for a wake whose conversation row no longer exists (deleted). */
export const CONVERSATION_GONE = 'conversation_not_found';

export interface AdmittedOwner {
  ownerId?: string;
  reason?: string;
}

/**
 * Settle and validate the one owner a wake batch may act for. The wake's owner must match the stored
 * agent, and, when the conversation exists, that conversation too — the exact boundary the account
 * layer relies on. Reads are unscoped so a foreign owner is refused before any write enters a scope.
 */
export async function resolveAdmittedOwner(store: Store, events: readonly WakeEvent[], target: WakeTarget): Promise<AdmittedOwner> {
  const resolved = resolveWakeOwner(events, target);
  if (resolved.ownerId === undefined) return { reason: resolved.reason ?? 'missing_owner' };
  const ownerId = resolved.ownerId;
  const childRunId = childRunIdOfSession(target.sessionKey, target.agentId, target.conversationId);
  if (childRunId === undefined) {
    if (docOwner(await store.get('agents', target.agentId)) !== ownerId) return { reason: 'agent_owner_mismatch' };
    const conversation = await store.get('conversations', target.conversationId);
    // A deleted conversation takes no wake: that is what keeps queued and late wakes from starting a run in it.
    if (conversation === null) return { reason: CONVERSATION_GONE };
    if (docOwner(conversation) !== ownerId) return { reason: 'conversation_owner_mismatch' };
    return { ownerId };
  }
  return admitChildSession(store, events, target, ownerId, childRunId);
}
function payloadId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function payloadOf(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event)) return undefined;
  const payload = event['payload'];
  if (!isRecord(payload)) return undefined;
  return payload;
}
function storedField(doc: unknown, key: string): string | undefined {
  if (!isRecord(doc)) return undefined;
  return payloadId(doc[key]);
}
async function admitChildSession(store: Store, events: readonly WakeEvent[], target: WakeTarget, ownerId: string, childRunId: string): Promise<AdmittedOwner> {
  const row = await store.get('runs', childRunId);
  if (row === null) return { reason: 'unknown_child_run' };
  const parentRunId = isRecord(row) ? payloadId(row['parentRunId']) : undefined;
  if (parentRunId === undefined) return { reason: 'unknown_child_run' };
  const childSession = storedField(row, 'childSessionKey');
  if (childSession !== target.sessionKey) return { reason: 'session_key_mismatch' };
  if (row.agentId !== target.agentId) return { reason: 'wake_target_mismatch' };
  const rowConversation = typeof row.conversationId === 'string' ? row.conversationId : undefined;
  if (rowConversation !== target.conversationId) return { reason: 'wake_target_mismatch' };
  if (docOwner(row) !== ownerId) return { reason: 'agent_owner_mismatch' };
  const parent = await store.get('runs', parentRunId);
  if (parent === null) return { reason: 'parent_not_found' };
  if (parent.conversationId !== target.conversationId) return { reason: 'parent_conversation_mismatch' };
  if (docOwner(parent) !== ownerId) return { reason: 'agent_owner_mismatch' };
  if (docOwner(await store.get('agents', target.agentId)) !== ownerId) return { reason: 'agent_owner_mismatch' };
  const conversation = await store.get('conversations', target.conversationId);
  if (conversation === null) return { reason: 'conversation_owner_mismatch' };
  if (docOwner(conversation) !== ownerId) return { reason: 'conversation_owner_mismatch' };
  if (!conversation.agentIds.includes(target.agentId)) return { reason: 'target_not_authorized' };
  const payload = payloadOf(events[0]);
  if (payloadId(payload?.['childRunId']) !== childRunId) return { reason: 'wake_target_mismatch' };
  if (payloadId(payload?.['parentRunId']) !== parentRunId) return { reason: 'wake_target_mismatch' };
  return { ownerId };
}
