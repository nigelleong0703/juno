/**
 * Raw SQL for the memory items (migration 0044). Every statement filters on owner_id. Rows come back as snake_case columns and are
 * mapped to the public shapes here; the rules (what a valid item is) live in service.ts.
 *
 * Parameters: DurableDb passes strings, numbers and null only, so the boolean is written as the text 'true' / 'false' and cast in
 * SQL, and the evidence is written as JSON text and cast to jsonb.
 */
import type { DurableDb } from '@agent-desktop/durable';
import type { ItemEvidence, ItemFilter, ItemTopic, MemoryItem, Presence, TopicSummary } from './types.js';

type Stamp = Date | string;

export interface ItemRow {
  id: string;
  owner_id: string;
  text: string;
  kind: string;
  file: string;
  topic: string | null;
  about_person_id: string | null;
  agent_id: string | null;
  said_by_person_id: string | null;
  said_by_account_id: string | null;
  said_by_agent_id: string | null;
  said_in: string;
  audience: string;
  sensitive: boolean;
  status: string;
  claim_id: string | null;
  evidence: ItemEvidence[] | null;
  legacy_ref: string | null;
  created_at: Stamp;
  updated_at: Stamp;
}

export type Db = DurableDb;

/**
 * One assignment of an UPDATE: the column, its value, and the cast the placeholder needs (none for text). Booleans and jsonb go
 * through text: the driver encodes a string bound to a boolean or jsonb placeholder with that type's own encoder (a boolean would
 * come back false, a JSON text would be stored as a JSON string), and a text placeholder is sent as it is.
 */
export interface Assignment {
  column: string;
  value: string | number | null;
  cast?: '::text::boolean' | '::text::jsonb';
}

export const COLUMNS = `id, owner_id, text, kind, file, topic, about_person_id, agent_id, said_by_person_id, said_by_account_id, said_by_agent_id,
  said_in, audience, sensitive, status, claim_id, evidence, legacy_ref, created_at, updated_at`;

const iso = (value: Stamp): string => (value instanceof Date ? value : new Date(value)).toISOString();

export function toItem(row: ItemRow): MemoryItem {
  return {
    id: row.id,
    ownerId: row.owner_id,
    text: row.text,
    kind: row.kind as MemoryItem['kind'],
    file: row.file as MemoryItem['file'],
    topic: row.topic as MemoryItem['topic'],
    aboutPersonId: row.about_person_id,
    agentId: row.agent_id,
    saidByPersonId: row.said_by_person_id,
    saidByAccountId: row.said_by_account_id,
    saidByAgentId: row.said_by_agent_id,
    saidIn: row.said_in,
    audience: row.audience,
    sensitive: row.sensitive,
    status: row.status as MemoryItem['status'],
    claimId: row.claim_id,
    evidence: row.evidence,
    legacyRef: row.legacy_ref,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** The values of one new row, already in column form: sensitive as 'true' / 'false', evidence as JSON text. */
export interface ItemInsert {
  id: string;
  owner_id: string;
  text: string;
  kind: string;
  file: string;
  topic: string | null;
  about_person_id: string | null;
  agent_id: string | null;
  said_by_person_id: string | null;
  said_by_account_id: string | null;
  said_by_agent_id: string | null;
  said_in: string;
  audience: string;
  sensitive: 'true' | 'false';
  status: string;
  claim_id: string | null;
  evidence: string | null;
  legacy_ref: string | null;
  created_at: string;
}

/** Insert a row; undefined when a row with the same legacy ref already exists (a migrated line is only ever taken once). */
export async function insertItem(db: Db, row: ItemInsert): Promise<ItemRow | undefined> {
  const [inserted] = await db.query<ItemRow>(
    `INSERT INTO memory_items (id, owner_id, text, kind, file, topic, about_person_id, agent_id, said_by_person_id, said_by_account_id, said_by_agent_id,
       said_in, audience, sensitive, status, claim_id, evidence, legacy_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::text::boolean, ?, ?, ?::text::jsonb, ?, ?::timestamptz, ?::timestamptz)
     ON CONFLICT (owner_id, legacy_ref) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      row.id, row.owner_id, row.text, row.kind, row.file, row.topic, row.about_person_id, row.agent_id, row.said_by_person_id, row.said_by_account_id,
      row.said_by_agent_id, row.said_in, row.audience, row.sensitive, row.status, row.claim_id, row.evidence, row.legacy_ref,
      row.created_at, row.created_at,
    ],
  );
  return inserted;
}

/** One row of this owner, or undefined. */
export async function getItemRow(db: Db, ownerId: string, id: string): Promise<ItemRow | undefined> {
  const [row] = await db.query<ItemRow>(`SELECT ${COLUMNS} FROM memory_items WHERE owner_id = ? AND id = ?`, [ownerId, id]);
  return row;
}

export async function findItemRowByLegacyRef(db: Db, ownerId: string, legacyRef: string): Promise<ItemRow | undefined> {
  const [row] = await db.query<ItemRow>(`SELECT ${COLUMNS} FROM memory_items WHERE owner_id = ? AND legacy_ref = ?`, [ownerId, legacyRef]);
  return row;
}

/** Set the given columns of one row and bump updated_at; undefined when the row is not this owner's. */
export async function updateItemRow(db: Db, ownerId: string, id: string, assignments: readonly Assignment[]): Promise<ItemRow | undefined> {
  const sets = [...assignments.map((entry) => `${entry.column} = ?${entry.cast ?? ''}`), 'updated_at = NOW()'].join(', ');
  const [row] = await db.query<ItemRow>(
    `UPDATE memory_items SET ${sets} WHERE owner_id = ? AND id = ? RETURNING ${COLUMNS}`,
    [...assignments.map((entry) => entry.value), ownerId, id],
  );
  return row;
}

/** Remove one row; true when there was one. */
export async function deleteItemRow(db: Db, ownerId: string, id: string): Promise<boolean> {
  const removed = await db.query<{ id: string }>(`DELETE FROM memory_items WHERE owner_id = ? AND id = ? RETURNING id`, [ownerId, id]);
  return removed.length > 0;
}

/**
 * The active rows one presence may read (`memoryFor`), oldest first. The filter is in SQL, so nothing outside it reaches the caller
 * or the ranking. Agent-private rows (agent_id set) are left out unless they are this agent's; the owner's app (no agent) sees all.
 * A non-owner presence reads only unsensitive rows of its own group, or public ones.
 */
export async function listVisibleRows(
  db: Db,
  ownerId: string,
  presence: Presence,
  agentId: string | undefined,
  withVectors: boolean,
): Promise<Array<ItemRow & { embedding?: number[] | null; embed_model?: string | null }>> {
  const clauses: string[] = ["owner_id = ?", "status = 'active'"];
  const params: string[] = [ownerId];
  if (presence.kind !== 'owner' || agentId !== undefined) {
    clauses.push('(agent_id IS NULL OR agent_id = ?)');
    params.push(agentId ?? '');
  }
  if (presence.kind === 'group') {
    clauses.push("sensitive = false AND (audience = ? OR audience = 'public')");
    params.push('group:' + presence.groupKey);
  } else if (presence.kind === 'other') {
    clauses.push("sensitive = false AND audience = 'public'");
  }
  const vectors = withVectors ? ', embedding, embed_model' : '';
  return db.query(`SELECT ${COLUMNS}${vectors} FROM memory_items WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`, params);
}

/** Store the vector of one row, only while its text is still the one that was embedded; false when the text has changed since. */
export async function setVectorRow(db: Db, ownerId: string, id: string, text: string, vector: { embedding: number[]; embedModel: string }): Promise<boolean> {
  const updated = await db.query<{ id: string }>(
    `UPDATE memory_items SET embedding = ?::text::jsonb, embed_model = ? WHERE owner_id = ? AND id = ? AND text = ? RETURNING id`,
    [JSON.stringify(vector.embedding), vector.embedModel, ownerId, id, text],
  );
  return updated.length > 0;
}

/** Rows that have no vector from `model` yet (retracted ones never need one), across owners, oldest first. For the boot backfill. */
export async function rowsNeedingVector(db: Db, model: string, limit: number): Promise<Array<{ owner_id: string; id: string; text: string }>> {
  return db.query(
    `SELECT owner_id, id, text FROM memory_items WHERE status <> 'retracted' AND (embedding IS NULL OR embed_model IS DISTINCT FROM ?) ORDER BY created_at, id LIMIT ?`,
    [model, limit],
  );
}

/** The owner's rows matching `filter`, oldest first. */
export async function listItemRows(db: Db, ownerId: string, filter: ItemFilter): Promise<ItemRow[]> {
  const clauses: string[] = ['owner_id = ?'];
  const params: Array<string> = [ownerId];
  const add = (column: string, value: string | undefined, cast = ''): void => {
    if (value === undefined) return;
    clauses.push(`${column} = ?${cast}`);
    params.push(value);
  };
  add('file', filter.file);
  add('about_person_id', filter.aboutPersonId);
  add('status', filter.status);
  add('agent_id', filter.agentId);
  add('claim_id', filter.claimId);
  if (filter.topic === 'other') clauses.push("(topic = 'other' OR topic IS NULL)");
  else add('topic', filter.topic);
  if (filter.createdFrom !== undefined) {
    clauses.push('created_at >= ?::timestamptz');
    params.push(filter.createdFrom);
  }
  return db.query<ItemRow>(`SELECT ${COLUMNS} FROM memory_items WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`, params);
}

interface SummaryRow {
  topic: string;
  summary: string;
  updated_at: Stamp;
}

/** The owner's topic summaries (migration 0050), by topic. */
export async function listSummaryRows(db: Db, ownerId: string): Promise<TopicSummary[]> {
  const rows = await db.query<SummaryRow>(`SELECT topic, summary, updated_at FROM memory_topic_summaries WHERE owner_id = ? ORDER BY topic`, [ownerId]);
  return rows.map((row) => ({ topic: row.topic as ItemTopic, summary: row.summary, updatedAt: iso(row.updated_at) }));
}

/** Writes (or replaces) one topic's summary. */
export async function putSummaryRow(db: Db, ownerId: string, topic: ItemTopic, summary: string, updatedAt: string): Promise<void> {
  await db.query(
    `INSERT INTO memory_topic_summaries (owner_id, topic, summary, updated_at) VALUES (?, ?, ?, ?::timestamptz)
     ON CONFLICT (owner_id, topic) DO UPDATE SET summary = EXCLUDED.summary, updated_at = EXCLUDED.updated_at`,
    [ownerId, topic, summary, updatedAt],
  );
}

export async function deleteSummaryRow(db: Db, ownerId: string, topic: ItemTopic): Promise<void> {
  await db.query(`DELETE FROM memory_topic_summaries WHERE owner_id = ? AND topic = ?`, [ownerId, topic]);
}
