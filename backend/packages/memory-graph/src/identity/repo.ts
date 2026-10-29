/**
 * Raw SQL for the identity graph (migration 0043). Every statement filters on owner_id; the rules (a new account gets a person,
 * a link moves the account and drops an empty person) live in service.ts. Rows come back as snake_case columns and are mapped to
 * the public shapes here.
 *
 * Parameters: DurableDb passes strings and numbers only, and the boolean is written as the text 'true' / 'false' and cast in SQL.
 */
import { randomUUID } from 'node:crypto';
import type { DurableDb } from '@agent-desktop/durable';
import type { Account, AccountPlatform, Person } from './types.js';

type Stamp = Date | string;

export interface PersonRow {
  id: string;
  owner_id: string;
  name: string;
  is_owner: boolean;
  created_at: Stamp;
  updated_at: Stamp;
}

export interface AccountRow {
  id: string;
  owner_id: string;
  platform: string;
  workspace: string;
  external_id: string;
  name: string | null;
  person_id: string | null;
  last_chat: string;
  first_seen: Stamp;
  last_seen: Stamp;
}

export type Db = DurableDb;

export function newId(prefix: 'per' | 'acc'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

const iso = (value: Stamp): string => (value instanceof Date ? value : new Date(value)).toISOString();

export function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    isOwner: row.is_owner,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    ownerId: row.owner_id,
    platform: row.platform as AccountPlatform,
    workspace: row.workspace,
    externalId: row.external_id,
    name: row.name,
    personId: row.person_id,
    lastChat: row.last_chat,
    firstSeen: iso(row.first_seen),
    lastSeen: iso(row.last_seen),
  };
}

export interface AccountKey {
  platform: AccountPlatform;
  workspace: string;
  externalId: string;
}

// ---------------------------------------------------------------- people

export async function findOwner(db: Db, ownerId: string): Promise<PersonRow | undefined> {
  const [row] = await db.query<PersonRow>(`SELECT * FROM people WHERE owner_id = ? AND is_owner`, [ownerId]);
  return row;
}

/** Insert the owner's person; a no-op when the owner has one already (the partial unique index on is_owner). */
export async function insertOwner(db: Db, ownerId: string, id: string, name: string): Promise<void> {
  await db.query(
    `INSERT INTO people (id, owner_id, name, is_owner) VALUES (?, ?, ?, 'true'::text::boolean) ON CONFLICT DO NOTHING`,
    [id, ownerId, name],
  );
}

export async function insertPerson(db: Db, ownerId: string, id: string, name: string): Promise<PersonRow> {
  const [row] = await db.query<PersonRow>(`INSERT INTO people (id, owner_id, name) VALUES (?, ?, ?) RETURNING *`, [id, ownerId, name]);
  if (!row) throw new Error('person insert returned no row');
  return row;
}

/** One person of this owner; `lock` takes its row lock until the transaction ends. */
export async function getPerson(db: Db, ownerId: string, id: string, lock: boolean): Promise<PersonRow | undefined> {
  const [row] = await db.query<PersonRow>(`SELECT * FROM people WHERE owner_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [ownerId, id]);
  return row;
}

export async function deletePerson(db: Db, ownerId: string, id: string): Promise<void> {
  await db.query(`DELETE FROM people WHERE owner_id = ? AND id = ?`, [ownerId, id]);
}

/** The person renamed, or undefined when it is not this owner's. */
export async function renamePersonRow(db: Db, ownerId: string, id: string, name: string): Promise<PersonRow | undefined> {
  const [row] = await db.query<PersonRow>(`UPDATE people SET name = ?, updated_at = NOW() WHERE owner_id = ? AND id = ? RETURNING *`, [name, ownerId, id]);
  return row;
}

// ---------------------------------------------------------------- accounts

export async function findAccount(db: Db, ownerId: string, key: AccountKey): Promise<AccountRow | undefined> {
  const [row] = await db.query<AccountRow>(
    `SELECT * FROM accounts WHERE owner_id = ? AND platform = ? AND workspace = ? AND external_id = ?`,
    [ownerId, key.platform, key.workspace, key.externalId],
  );
  return row;
}

/**
 * Insert an account, or on its key refresh the name and last-seen time (the person is never touched here). Returns the row as it
 * is now, so a concurrent first sighting that won the key returns that row, and the caller knows whether its own person was used.
 */
export async function insertAccount(db: Db, ownerId: string, id: string, personId: string | null, key: AccountKey, name: string | null, chat: string | null): Promise<AccountRow> {
  const [row] = await db.query<AccountRow>(
    `INSERT INTO accounts (id, owner_id, platform, workspace, external_id, name, person_id, last_chat)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, ''))
     ON CONFLICT (owner_id, platform, workspace, external_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, accounts.name),
       last_chat = COALESCE(?, accounts.last_chat),
       last_seen = NOW()
     RETURNING *`,
    [id, ownerId, key.platform, key.workspace, key.externalId, name, personId, chat, chat],
  );
  if (!row) throw new Error('account insert returned no row');
  return row;
}

export async function touchAccount(db: Db, ownerId: string, id: string, name: string | null, chat: string | null): Promise<AccountRow> {
  const [row] = await db.query<AccountRow>(
    `UPDATE accounts SET name = COALESCE(?, name), last_chat = COALESCE(?, last_chat), last_seen = NOW() WHERE owner_id = ? AND id = ? RETURNING *`,
    [name, chat, ownerId, id],
  );
  if (!row) throw new Error('account touch matched no row');
  return row;
}

/** Every account of the owner, most recently seen first (at most `limit`): person_link looks an account up by its name among these. */
export async function listAccountRows(db: Db, ownerId: string, limit: number): Promise<AccountRow[]> {
  return db.query<AccountRow>(`SELECT * FROM accounts WHERE owner_id = ? ORDER BY last_seen DESC, id LIMIT ?`, [ownerId, limit]);
}

export async function getAccount(db: Db, ownerId: string, id: string, lock: boolean): Promise<AccountRow | undefined> {
  const [row] = await db.query<AccountRow>(`SELECT * FROM accounts WHERE owner_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [ownerId, id]);
  return row;
}

export async function moveAccount(db: Db, ownerId: string, id: string, personId: string): Promise<AccountRow> {
  const [row] = await db.query<AccountRow>(`UPDATE accounts SET person_id = ? WHERE owner_id = ? AND id = ? RETURNING *`, [personId, ownerId, id]);
  if (!row) throw new Error('account move matched no row');
  return row;
}

export async function accountRowsOf(db: Db, ownerId: string, personId: string): Promise<AccountRow[]> {
  return db.query<AccountRow>(`SELECT * FROM accounts WHERE owner_id = ? AND person_id = ? ORDER BY first_seen, id`, [ownerId, personId]);
}

/** The owner's people, oldest first, at most `limit`. */
export async function listPeopleRows(db: Db, ownerId: string, limit: number): Promise<PersonRow[]> {
  return db.query<PersonRow>(`SELECT * FROM people WHERE owner_id = ? ORDER BY created_at, id LIMIT ?`, [ownerId, limit]);
}

export async function countAccounts(db: Db, ownerId: string, personId: string): Promise<number> {
  const [row] = await db.query<{ n: string | number }>(`SELECT COUNT(*) AS n FROM accounts WHERE owner_id = ? AND person_id = ?`, [ownerId, personId]);
  return Number(row?.n ?? 0);
}

/** The owner's accounts whose id starts with `prefix` (a short form shown in a header), at most 20. `left()` rather than LIKE: `_` is a LIKE wildcard. */
export async function accountsWithPrefix(db: Db, ownerId: string, prefix: string): Promise<AccountRow[]> {
  return db.query<AccountRow>(`SELECT * FROM accounts WHERE owner_id = ? AND left(id, ?) = ? ORDER BY id LIMIT 20`, [ownerId, prefix.length, prefix]);
}
