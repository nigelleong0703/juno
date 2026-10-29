/**
 * Raw SQL for the relations (migration 0048). Every statement filters on owner_id. DurableDb passes strings, numbers and null only, so
 * the boolean is written as the text 'true' / 'false' and cast in SQL, and the evidence is JSON text cast to jsonb.
 */
import type { DurableDb } from '@agent-desktop/durable';
import type { RelationEvidence, RelationKind, Relation, RelationView } from './types.js';

type Stamp = Date | string;

export interface RelationRow {
  id: string;
  owner_id: string;
  person_a: string;
  kind: string;
  person_b: string;
  kind_label: string | null;
  valid_from: Stamp;
  valid_to: Stamp | null;
  evidence: RelationEvidence | null;
  said_by_person_id: string | null;
  said_by_account_id: string | null;
  confirmed: boolean;
  created_at: Stamp;
  updated_at: Stamp;
}

export interface RelationViewRow extends RelationRow {
  person_a_name: string;
  person_b_name: string;
  said_by_name: string | null;
}

const iso = (value: Stamp): string => (value instanceof Date ? value : new Date(value)).toISOString();

/** The columns of a row, unqualified (a single-table statement). */
export const COLUMNS = `id, owner_id, person_a, kind, person_b, kind_label, valid_from, valid_to, evidence,
  said_by_person_id, said_by_account_id, confirmed, created_at, updated_at`;
/** The same columns qualified with `r.`, for the statements that join the people table. */
const QUALIFIED = `r.id, r.owner_id, r.person_a, r.kind, r.person_b, r.kind_label, r.valid_from, r.valid_to, r.evidence,
  r.said_by_person_id, r.said_by_account_id, r.confirmed, r.created_at, r.updated_at`;

export function toRelation(row: RelationRow): Relation {
  return {
    id: row.id,
    ownerId: row.owner_id,
    personA: row.person_a,
    kind: row.kind as RelationKind,
    personB: row.person_b,
    kindLabel: row.kind_label,
    validFrom: iso(row.valid_from),
    validTo: row.valid_to === null ? null : iso(row.valid_to),
    evidence: row.evidence,
    saidByPersonId: row.said_by_person_id,
    saidByAccountId: row.said_by_account_id,
    confirmed: row.confirmed,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toView(row: RelationViewRow): RelationView {
  return { ...toRelation(row), personAName: row.person_a_name, personBName: row.person_b_name, saidByName: row.said_by_name };
}

/** The columns of one new row, in column form. */
export interface RelationInsert {
  id: string;
  owner_id: string;
  person_a: string;
  kind: RelationKind;
  person_b: string;
  kind_label: string | null;
  valid_from: string;
  evidence: string | null;
  said_by_person_id: string | null;
  said_by_account_id: string | null;
  confirmed: 'true' | 'false';
  at: string;
}

export async function insertRelation(db: DurableDb, row: RelationInsert): Promise<RelationRow> {
  const [inserted] = await db.query<RelationRow>(
    `INSERT INTO relations (id, owner_id, person_a, kind, person_b, kind_label, valid_from, evidence, said_by_person_id, said_by_account_id, confirmed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?::timestamptz, ?::text::jsonb, ?, ?, ?::text::boolean, ?::timestamptz, ?::timestamptz)
     RETURNING ${COLUMNS}`,
    [row.id, row.owner_id, row.person_a, row.kind, row.person_b, row.kind_label, row.valid_from, row.evidence, row.said_by_person_id,
      row.said_by_account_id, row.confirmed, row.at, row.at],
  );
  if (inserted === undefined) throw new Error('the relation insert returned no row');
  return inserted;
}

/** Whether a person of this owner exists. */
export async function personExists(db: DurableDb, ownerId: string, personId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(`SELECT id FROM people WHERE owner_id = ? AND id = ?`, [ownerId, personId]);
  return rows.length > 0;
}

/** The open (not yet closed) row with exactly this kind and these two ends, or undefined. */
export async function openTriple(db: DurableDb, ownerId: string, kind: RelationKind, a: string, b: string): Promise<RelationRow | undefined> {
  const [row] = await db.query<RelationRow>(
    `SELECT ${COLUMNS} FROM relations WHERE owner_id = ? AND kind = ? AND person_a = ? AND person_b = ? AND valid_to IS NULL`,
    [ownerId, kind, a, b],
  );
  return row;
}

/**
 * The open rows an exclusive kind's new statement would replace: for manager_of the same report (person_b) with another manager; for
 * works_at the same employee (person_a) with another employer. Statements about other people are not affected.
 */
export async function openConflicts(db: DurableDb, ownerId: string, kind: RelationKind, a: string, b: string): Promise<RelationRow[]> {
  if (kind === 'manager_of') {
    return db.query<RelationRow>(
      `SELECT ${COLUMNS} FROM relations WHERE owner_id = ? AND kind = ? AND person_b = ? AND person_a <> ? AND valid_to IS NULL`,
      [ownerId, kind, b, a],
    );
  }
  return db.query<RelationRow>(
    `SELECT ${COLUMNS} FROM relations WHERE owner_id = ? AND kind = ? AND person_a = ? AND person_b <> ? AND valid_to IS NULL`,
    [ownerId, kind, a, b],
  );
}

/** Close rows: they stop holding at `at`, and keep their history. */
export async function closeRows(db: DurableDb, ownerId: string, ids: readonly string[], at: string): Promise<void> {
  for (const id of ids) {
    await db.query(`UPDATE relations SET valid_to = ?::timestamptz, updated_at = ?::timestamptz WHERE owner_id = ? AND id = ?`, [at, at, ownerId, id]);
  }
}

/** The owner's word now confirms an open relation the digest had recorded unconfirmed. */
export async function confirmRow(db: DurableDb, ownerId: string, id: string, at: string): Promise<void> {
  await db.query(`UPDATE relations SET confirmed = ?::text::boolean, updated_at = ?::timestamptz WHERE owner_id = ? AND id = ?`, ['true', at, ownerId, id]);
}

/** One row of this owner (open or closed), or undefined. */
export async function getRelationRow(db: DurableDb, ownerId: string, id: string): Promise<RelationRow | undefined> {
  const [row] = await db.query<RelationRow>(`SELECT ${COLUMNS} FROM relations WHERE owner_id = ? AND id = ?`, [ownerId, id]);
  return row;
}

/** Deletes one row of this owner; false when there was none. */
export async function deleteRelationRow(db: DurableDb, ownerId: string, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(`DELETE FROM relations WHERE owner_id = ? AND id = ? RETURNING id`, [ownerId, id]);
  return rows.length > 0;
}

/** How many rows (open or closed) name this person: a person with any of them is not deleted. */
export async function countRelationsOf(db: DurableDb, ownerId: string, personId: string): Promise<number> {
  const [row] = await db.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM relations WHERE owner_id = ? AND (person_a = ? OR person_b = ?)`,
    [ownerId, personId, personId],
  );
  return Number(row?.n ?? 0);
}

const VIEW_FROM = `FROM relations r
  JOIN people pa ON pa.owner_id = r.owner_id AND pa.id = r.person_a
  JOIN people pb ON pb.owner_id = r.owner_id AND pb.id = r.person_b
  LEFT JOIN people ps ON ps.owner_id = r.owner_id AND ps.id = r.said_by_person_id`;
const VIEW_COLUMNS = `${QUALIFIED}, pa.name AS person_a_name, pb.name AS person_b_name, ps.name AS said_by_name`;

/** The open relations that name this person on either side, oldest first. */
export async function currentRowsOf(db: DurableDb, ownerId: string, personId: string): Promise<RelationViewRow[]> {
  return db.query<RelationViewRow>(
    `SELECT ${VIEW_COLUMNS} ${VIEW_FROM} WHERE r.owner_id = ? AND r.valid_to IS NULL AND (r.person_a = ? OR r.person_b = ?) ORDER BY r.valid_from, r.id`,
    [ownerId, personId, personId],
  );
}

/** Every open relation of the owner, oldest first (at most `limit`). */
export async function listCurrentRows(db: DurableDb, ownerId: string, limit: number): Promise<RelationViewRow[]> {
  return db.query<RelationViewRow>(
    `SELECT ${VIEW_COLUMNS} ${VIEW_FROM} WHERE r.owner_id = ? AND r.valid_to IS NULL ORDER BY r.valid_from, r.id LIMIT ?`,
    [ownerId, limit],
  );
}
