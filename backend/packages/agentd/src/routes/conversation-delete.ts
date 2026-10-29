import type { Collection, ListQuery, Store } from '@agent-desktop/contracts';
import { sessionKey } from '@agent-desktop/contracts';
import type { Run } from '@agent-desktop/public-contracts';
import { CHILD_SESSION_MARKER } from 'juno-agent/execution/execution-owner';
import { docOwnerId } from './relationships.js';
import { stopRunTruthfully, TERMINAL_RUN_STATUSES } from './runs.js';
import type { AgentdDeps } from './index.js';

export type CascadeResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 502; code: string; message: string };

const PAGE = 200;
/** Stop rounds: a queued batch can start the moment a stopped run releases its session, so look again. */
const STOP_ROUNDS = 3;
const STOP_WAIT_MS = 15_000;
const STOP_POLL_MS = 100;

/** Collections whose rows carry the conversation id as an indexed column. */
const BY_CONVERSATION: Collection[] = ['items', 'requests', 'subscriptions', 'eventReceipts', 'backgroundTasks', 'agentTasks', 'browserGoalGates'];

/** Every id of one collection matching an indexed filter, read page by page. */
async function idsWhere(store: Store, collection: Collection, where: NonNullable<ListQuery['where']>): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(collection, { where, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const doc of page.items) ids.push(doc.id);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return ids;
}

async function runsOf(store: Store, conversationId: string): Promise<Run[]> {
  const runs: Run[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list('runs', { where: { conversationId }, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return runs;
}

/** Wait until every run row is terminal: a run that is still finalizing must not find its rows deleted. */
async function settled(store: Store, runIds: string[]): Promise<boolean> {
  const deadline = Date.now() + STOP_WAIT_MS;
  for (;;) {
    let pending = false;
    for (const id of runIds) {
      const row = await store.get('runs', id);
      if (row !== null && !TERMINAL_RUN_STATUSES.has(row.status)) pending = true;
    }
    if (!pending) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
}

/** Stop every live run of the conversation (children included, they share its conversationId). */
export async function stopLiveRuns(deps: AgentdDeps, conversationId: string): Promise<CascadeResult> {
  for (let round = 0; round < STOP_ROUNDS; round += 1) {
    const live = (await runsOf(deps.store, conversationId)).filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
    if (live.length === 0) return { ok: true };
    for (const run of live) {
      const outcome = await stopRunTruthfully(deps, run);
      if (outcome === 'failed') {
        return { ok: false, status: 502, code: 'STOP_FAILED', message: 'A running task could not be stopped; nothing was deleted. Try again.' };
      }
    }
    if (!(await settled(deps.store, live.map((run) => run.id)))) break;
  }
  const stillLive = (await runsOf(deps.store, conversationId)).some((run) => !TERMINAL_RUN_STATUSES.has(run.status));
  if (!stillLive) return { ok: true };
  return { ok: false, status: 409, code: 'RUNS_STILL_STOPPING', message: 'A running task is still stopping; nothing was deleted. Try again.' };
}

/** Delete the rows of a session-keyed collection that belong to the conversation's sessions. */
async function deleteSessionRows(store: Store, collection: 'transcripts' | 'compactions', inSession: (key: string) => boolean): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.list(collection, { limit: PAGE * 2, ...(cursor === undefined ? {} : { cursor }) });
    for (const doc of page.items) if (inSession(doc.sessionKey)) await store.delete(collection, doc.id);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

/**
 * Delete one conversation and everything that belongs to it, for the conversation's owner only (anyone else sees 404).
 * Order: stop its live runs and wait for them to finish (a run that is still finalizing would patch rows we delete),
 * then in one transaction delete steps and runs, items, requests, subscriptions, event receipts, the session
 * transcripts and compactions (the conversation's session `agentId:conversationId` and its `::child:` sessions),
 * and the conversation, then emit `conversation.deleted`. Audit rows are kept; memory lives in the home files and claims, not in the conversation.
 * Wakes still queued for the conversation are refused later: admission no longer finds the conversation.
 */
export async function deleteConversationCascade(deps: AgentdDeps, ownerId: string, conversationId: string): Promise<CascadeResult> {
  const conv = await deps.store.get('conversations', conversationId);
  if (conv === null || docOwnerId(conv) !== ownerId) {
    return { ok: false, status: 404, code: 'CONVERSATION_NOT_FOUND', message: 'Conversation ' + conversationId + ' not found' };
  }
  const stopped = await stopLiveRuns(deps, conversationId);
  if (!stopped.ok) return stopped;

  await deps.store.tx(async (store) => {
    const runs = await runsOf(store, conversationId);
    for (const run of runs) {
      for (const stepId of await idsWhere(store, 'steps', { runId: run.id })) await store.delete('steps', stepId);
      await store.delete('runs', run.id);
    }
    for (const collection of BY_CONVERSATION) {
      for (const id of await idsWhere(store, collection, { conversationId })) await store.delete(collection, id);
    }
    const roots = [...new Set([...conv.agentIds, ...runs.map((run) => run.agentId)])].map((agentId) => sessionKey(agentId, conversationId));
    const inSession = (key: string): boolean => roots.some((root) => key === root || key.startsWith(root + CHILD_SESSION_MARKER));
    await deleteSessionRows(store, 'transcripts', inSession);
    await deleteSessionRows(store, 'compactions', inSession);
    await store.delete('conversations', conversationId);
  });
  await deps.store.emit({ type: 'conversation.deleted', conversationId });
  return { ok: true };
}
