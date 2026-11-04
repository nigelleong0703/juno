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
  cast?: '::text::boolean' | '::text::jsonb' | '::text::vector';
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
export async function listVisibleRows(db: Db, ownerId: string, presence: Presence, agentId: string | undefined): Promise<ItemRow[]> {
  const { where, params } = visibleWhere(ownerId, presence, agentId);
  return db.query(`SELECT ${COLUMNS} FROM memory_items WHERE ${where} ORDER BY created_at, id`, params);
}

/** The read rules of `memoryFor` as a WHERE clause (BACKEND §5.3, §5.4a); the one place they are written, shared by the list and the vector search. */
function visibleWhere(ownerId: string, presence: Presence, agentId: string | undefined): { where: string; params: string[] } {
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
  return { where: clauses.join(' AND '), params };
}

/** Store the vector of one row, only while its text is still the one that was embedded; false when the text has changed since. A vector of another length than the column's is refused by Postgres ("expected N dimensions"). */
export async function setVectorRow(db: Db, ownerId: string, id: string, text: string, vector: { embedding: number[]; embedModel: string }): Promise<boolean> {
  const updated = await db.query<{ id: string }>(
    `UPDATE memory_items SET embedding = ?::text::vector, embed_model = ? WHERE owner_id = ? AND id = ? AND text = ? RETURNING id`,
    [JSON.stringify(vector.embedding), vector.embedModel, ownerId, id, text],
  );
  return updated.length > 0;
}

/**
 * The rows nearest to `query` by cosine, closest first, among the rows `memoryFor` would return (same WHERE) that carry a vector from
 * `model`; with `ids` only among those. `ORDER BY embedding <=> q LIMIT k` is what the HNSW index answers. The owner/visibility filter
 * is applied to the index's candidates, so the scan is iterative (pgvector 0.8): it keeps going until `limit` rows pass the filter.
 */
export async function nearestRows(
  db: Db,
  ownerId: string,
  presence: Presence,
  agentId: string | undefined,
  query: { embedding: number[]; embedModel: string },
  options: { limit: number; ids?: readonly string[] },
): Promise<Array<{ id: string; cosine: number }>> {
  const { where, params } = visibleWhere(ownerId, presence, agentId);
  const vector = JSON.stringify(query.embedding);
  const restrict = options.ids === undefined ? '' : ' AND id IN (SELECT jsonb_array_elements_text(?::text::jsonb))';
  const rows = await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL hnsw.iterative_scan = strict_order`);
    return tx.query<{ id: string; cosine: number | string }>(
      `SELECT id, 1 - (embedding <=> ?::text::vector) AS cosine FROM memory_items
       WHERE ${where} AND embedding IS NOT NULL AND embed_model = ?${restrict}
       ORDER BY embedding <=> ?::text::vector LIMIT ?`,
      [vector, ...params, query.embedModel, ...(options.ids === undefined ? [] : [JSON.stringify(options.ids)]), vector, options.limit],
    );
  });
  return rows.map((row) => ({ id: row.id, cosine: Number(row.cosine) }));
}

/** The dimension of the embedding column (`vector(n)`), read from the catalog. */
export async function embeddingDimension(db: Db): Promise<number | undefined> {
  const [row] = await db.query<{ type: string }>(
    `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = 'memory_items'::regclass AND attname = 'embedding'`,
  );
  const match = /^vector\((\d+)\)$/.exec(row?.type ?? '');
  return match === null ? undefined : Number(match[1]);
}

/**
 * Makes the column hold `dimension`-long vectors. A different length means another model: every stored vector is dropped (the backfill
 * embeds them again), the column is retyped and the HNSW index rebuilt, in one transaction. False when nothing had to change.
 */
export async function alignEmbeddingDimension(db: Db, dimension: number): Promise<boolean> {
  if (!Number.isInteger(dimension) || dimension < 1) throw new Error(`invalid embedding dimension: ${String(dimension)}`);
  return db.transaction(async (tx) => {
    if ((await embeddingDimension(tx)) === dimension) return false;
    await tx.query(`DROP INDEX IF EXISTS memory_items_embedding_hnsw`);
    await tx.query(`UPDATE memory_items SET embedding = NULL, embed_model = NULL WHERE embedding IS NOT NULL`);
    await tx.query(`ALTER TABLE memory_items ALTER COLUMN embedding TYPE vector(${String(dimension)})`);
    await tx.query(`CREATE INDEX memory_items_embedding_hnsw ON memory_items USING hnsw (embedding vector_cosine_ops)`);
    return true;
  });
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
