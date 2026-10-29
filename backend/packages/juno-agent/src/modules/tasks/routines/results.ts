/**
 * Routine result evidence: a run's visible outputs, bounded run history, pause notices and
 * read evidence. Read evidence comes from the bounded routine history's recorded output IDs
 * (written at completion), never from scanning a long conversation: even with thousands of
 * older items, the newest routine outputs are addressed directly, and the cutoff still applies.
 */
import type { Store } from '../../../contracts/index.js';
import type { Item, Routine, RoutineRun } from '@agent-desktop/public-contracts';
import { appendHistory, MAX_READ_RESULT_IDS, ROUTINE_RUN_HISTORY_LIMIT } from './policies.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';

const SCAN_PAGE_SIZE = 200;
const MAX_STORED_OUTPUT_IDS = 200;

function isAgentMessage(item: unknown): item is Item & { type: 'agent_message'; runId?: string } {
  return typeof item === 'object' && item !== null && Reflect.get(item, 'type') === 'agent_message';
}

export interface CollectedOutputs {
  /** Output ids for the history record (bounded); the read-evidence source. */
  ids: string[];
  /** Total matching outputs seen; ids beyond the bound still count toward the streak. */
  count: number;
}

/**
 * Every visible output one run produced in its conversation (agent bubbles stamped with the
 * run). The runId query pages through all matching rows; retained ids are bounded for
 * history while the count remains complete.
 */
export async function collectRoutineOutputs(store: Store, conversationId: string, runId: string): Promise<CollectedOutputs> {
  const ids: string[] = [];
  let count = 0;
  let cursor: string | undefined;
  do {
    const listed = await store.list('items', { limit: SCAN_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }), where: { conversationId, runId } });
    for (const item of listed.items) {
      if (!isAgentMessage(item) || item.conversationId !== conversationId || item.runId !== runId) continue;
      count += 1;
      if (ids.length < MAX_STORED_OUTPUT_IDS) ids.push(item.id);
    }
    cursor = listed.nextCursor;
  } while (cursor !== undefined);
  return { ids, count };
}

/**
 * Read evidence from the bounded routine history: output ids of runs finished at/before the
 * cutoff (newest last, bounded). No conversation scan, so long histories cannot hide the
 * newest outputs; the cutoff still excludes anything produced after the read.
 */
export function resultIdsForHistory(routine: Routine, cutoff: string): string[] {
  const ids: string[] = [];
  for (const run of routine.runs) {
    const finishedAt = run.finishedAt ?? run.startedAt;
    if (finishedAt > cutoff || run.outputIds === undefined) continue;
    ids.push(...run.outputIds);
  }
  return ids.slice(-MAX_READ_RESULT_IDS);
}

/** A cutoff cannot claim unread outputs the receipt did not actually observe. */
export function hasReadEvidence(routine: Routine, cutoff: string, resultIds: readonly string[]): boolean {
  const latest = [...routine.runs].reverse().find(run => (run.outputIds?.length ?? 0) > 0);
  if (latest === undefined || (latest.finishedAt ?? latest.startedAt) > cutoff) return true;
  const observed = new Set(resultIds);
  return latest.outputIds?.every(id => observed.has(id)) ?? true;
}

export interface RoutineRunInput {
  id: string;
  routineId: string;
  status: 'completed' | 'failed';
  summary: string;
  runId?: string;
  outputIds?: string[];
  startedAt: string;
  finishedAt?: string;
}

/** Persist one routine run: bounded history plus last-run pointers for the UI. */
export async function appendRoutineRun(store: Store, routine: Routine, entry: RoutineRunInput): Promise<RoutineRun[]> {
  const record: RoutineRun = {
    id: entry.id,
    routineId: entry.routineId,
    status: entry.status,
    summary: entry.summary,
    ...(entry.runId === undefined ? {} : { runId: entry.runId }),
    ...(entry.outputIds === undefined ? {} : { outputIds: entry.outputIds.slice(-MAX_STORED_OUTPUT_IDS) }),
    startedAt: entry.startedAt,
    ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
  };
  const runs = appendHistory(routine.runs, record, ROUTINE_RUN_HISTORY_LIMIT);
  await store.patch('routines', routine.id, {
    runs,
    lastRunAt: entry.finishedAt ?? entry.startedAt,
    lastRunStatus: entry.status,
  });
  return runs;
}

/**
 * Occurrences that came due while the server was offline and were not run (BACKEND 3.6): one visible history entry. It is a
 * fact about the schedule, not a run, so it leaves `lastRunAt` / `lastRunStatus` and the streaks alone. The id is derived from
 * the newest skipped occurrence, so a retried delivery records it once.
 */
export async function appendSkippedRoutineRun(store: Store, routine: Routine, input: { id: string; at: string; summary: string }): Promise<void> {
  const current = (await store.get('routines', routine.id))?.runs ?? routine.runs;
  if (current.some((entry) => entry.id === input.id)) return;
  const record: RoutineRun = { id: input.id, routineId: routine.id, status: 'skipped', summary: input.summary, startedAt: input.at, finishedAt: input.at };
  await store.patch('routines', routine.id, { runs: appendHistory(current, record, ROUTINE_RUN_HISTORY_LIMIT) });
}

/** Chat-local pause notice (never an external push). Skipped when notify mode is never. */
export async function writePauseNotice(
  store: Store,
  routine: Routine,
  conversationId: string,
  reason: 'unread' | 'failed',
  at: string,
): Promise<string | undefined> {
  if (routine.notify.mode === 'never') return undefined;
  const text =
    reason === 'unread'
      ? `Routine "${routine.name}" auto-paused after 5 unread results. Mark the chat read or re-enable to resume.`
      : `Routine "${routine.name}" auto-paused after 5 consecutive failures. Fix the failure and re-enable to resume.`;
  const item = {
    id: `ntc-${routine.id}-${Date.parse(at)}`,
    conversationId,
    type: 'system' as const,
    level: 'warning' as const,
    text,
    at,
  };
  await store.put('items', item, { conversationId });
  await emitItemAdded(store, conversationId, item);
  return item.id;
}
