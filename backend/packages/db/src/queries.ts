/**
 * Document-row projections and the keyset list query for the Postgres store.
 * `put`/`patch` derive the indexed columns here; `list` builds filters, ordering and cursors here.
 */
import type { Collection, Doc, IndexedFields, ListPage, ListQuery } from '@agent-desktop/contracts';
import { z } from 'zod';
import type { Queryable } from './connection.js';
import { readString } from './guards.js';

/** A doc row; `doc` carries the contract model shape so jsonb returns without assertions. */
export interface DocRow<T> {
  id: string;
  owner_id: string;
  doc: T;
  created_at: string;
  updated_at: string;
  agent_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  status: string | null;
  kind: string | null;
  parent_id: string | null;
  sort_at: string;
}

export interface EventRow {
  id: number | bigint | string;
  owner_id: string;
  payload: unknown;
  created_at: string;
}

/**
 * Convert camelCase collection names to snake_case table names.
 * Examples: routineRuns -> routine_runs, eventReceipts -> event_receipts
 */
export function tableFor(collection: string): string {
  return collection
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

export const cursorSchema = z.object({ id: z.string(), at: z.string() });

/** Derive the indexed columns for a doc: an explicit `index` wins, otherwise read from the record. */
export function projections(record: Record<string, unknown>, index: IndexedFields = {}) {
  const pick = (key: keyof IndexedFields) =>
    index[key] !== undefined ? index[key] : readString(record, key) ?? null;
  const timestamp = readString(record, 'at') ?? readString(record, 'createdAt') ?? readString(record, 'startedAt');
  const at = timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
  return {
    agentId: pick('agentId'), conversationId: pick('conversationId'), runId: pick('runId'),
    // A child run names its parent in `parentRunId`; that is what the indexed `parent_id` holds for a run.
    status: pick('status'), kind: pick('kind') ?? readString(record, 'sessionKey') ?? null,
    parentId: pick('parentId') ?? readString(record, 'parentRunId') ?? null, at,
  };
}

/** One keyset page: filter by indexed columns, order by `at` or `id`, return the next cursor. */
export async function listPage<C extends Collection>(
  currentSql: Queryable,
  collection: C,
  query?: ListQuery,
  ownerId?: string
): Promise<ListPage<Doc<C>>> {
  const pageSize = query?.limit ?? 20;
  const ascending = query?.order !== 'desc';
  const direction = ascending ? currentSql`ASC` : currentSql`DESC`;
  const byTime = query?.orderBy === 'at';
  const sortKey = byTime ? currentSql`COALESCE(at, '-infinity'::timestamptz)` : currentSql`id`;
  let filters = currentSql`TRUE`;
  if (ownerId !== undefined) filters = currentSql`${filters} AND owner_id = ${ownerId}`;
  const where = query?.where;
  const add = (condition: ReturnType<typeof currentSql>) => {
    filters = currentSql`${filters} AND ${condition}`;
  };
  if (where?.ids) add(currentSql`id = ANY(${where.ids})`);
  if (where?.agentId !== undefined) add(currentSql`agent_id IS NOT DISTINCT FROM ${where.agentId}`);
  if (where?.conversationId !== undefined) add(currentSql`conversation_id IS NOT DISTINCT FROM ${where.conversationId}`);
  if (where?.runId !== undefined) add(currentSql`run_id IS NOT DISTINCT FROM ${where.runId}`);
  if (where?.status !== undefined) add(currentSql`status IS NOT DISTINCT FROM ${where.status}`);
  if (where?.kind !== undefined) add(currentSql`kind IS NOT DISTINCT FROM ${where.kind}`);
  if (where?.parentId !== undefined) add(currentSql`parent_id IS NOT DISTINCT FROM ${where.parentId}`);
  if (where?.initiator !== undefined) add(currentSql`initiator = ${where.initiator}`);
  if (where?.unattended !== undefined) add(currentSql`unattended = ${where.unattended}`);
  if (where?.statuses !== undefined) add(currentSql`status = ANY(${where.statuses})`);
  if (where?.hasParent !== undefined) add(where.hasParent ? currentSql`parent_id IS NOT NULL` : currentSql`parent_id IS NULL`);
  if (where?.hasRoutine !== undefined) add(where.hasRoutine ? currentSql`routine_id IS NOT NULL` : currentSql`routine_id IS NULL`);
  if (where?.routineId !== undefined) add(currentSql`routine_id = ${where.routineId}`);
  // A keyset position is compared (and ordered) with ids as plain bytes, so a merge of several sources sorts the same way everywhere.
  const idKey = query?.keyset ? currentSql`id COLLATE "C"` : currentSql`id`;
  if (query?.keyset && byTime) {
    const comparison = ascending ? currentSql`>` : currentSql`<`;
    add(currentSql`(${sortKey}, ${idKey}) ${comparison} (${query.keyset.at}::timestamptz, ${query.keyset.id}::text COLLATE "C")`);
  }
  if (query?.cursor) {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
    const comparison = ascending ? currentSql`>` : currentSql`<`;
    if (byTime) add(currentSql`(${sortKey}, id) ${comparison} (${cursor.at}::timestamptz, ${cursor.id})`);
    else add(currentSql`id ${comparison} ${cursor.id}`);
  }
  const result = await currentSql<Array<DocRow<Doc<C>>>>`
    SELECT *, COALESCE(at, '-infinity'::timestamptz)::text AS sort_at
    FROM ${currentSql(tableFor(String(collection)))}
    WHERE ${filters}
    ORDER BY ${sortKey} ${direction}, ${idKey} ${direction}
    LIMIT ${pageSize + 1}
  `;
  const pageItems = result.slice(0, pageSize);
  const last = pageItems.at(-1);
  const nextCursor = result.length > pageSize && last
    ? Buffer.from(JSON.stringify({ id: last.id, at: last.sort_at })).toString('base64url')
    : undefined;
  return { items: pageItems.map((row) => row.doc), nextCursor };
}
