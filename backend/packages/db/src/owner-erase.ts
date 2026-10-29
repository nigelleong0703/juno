/**
 * Raw-SQL pieces of deleting an account (BACKEND §5.2c), for the steps the document `Store` cannot do in bulk: every row of one
 * owner in every collection, the owner's event log, the sign-in rows, and the check whether a blob is still named by anyone else.
 * Each one filters on the owner id (or user id) in SQL and is safe to run again.
 */
import type { Collection } from '@agent-desktop/contracts';
import type { DurableDb } from '@agent-desktop/durable';
import { tableFor } from './queries.js';

/** Every collection, so a new one cannot be forgotten: the check below stops compiling until it is listed here. */
export const COLLECTION_NAMES = [
  'accountDeletions', 'agents', 'computers', 'screens', 'controls', 'conversations', 'items', 'runs', 'steps', 'requests', 'routines', 'rules', 'audit',
  'memoryEntries', 'memoryClaims', 'agentHome', 'goals', 'ideas', 'meals', 'agentCalendar', 'feedPosts', 'devices', 'skills', 'plugins',
  'connections', 'agentApps', 'appCatalog', 'modelProviders', 'modelProviderLogins', 'library', 'artifactFiles', 'documentDrafts', 'spaces', 'spaceHosted', 'settings', 'secureVault', 'profiles',
  'inspirations', 'channels', 'channelInstallations', 'meetingSessions', 'subscriptions', 'eventReceipts', 'compactions', 'transcripts',
  'browserGoalGates', 'agentTasks', 'backgroundTasks', 'artifacts', 'monitorState', 'proactiveLog',
  'ownerPresence', 'phoneCalls', 'voiceCalls',
] satisfies readonly Collection[];
type Unlisted = Exclude<Collection, (typeof COLLECTION_NAMES)[number]>;
const everyCollectionIsListed: [Unlisted] extends [never] ? true : never = true;
void everyCollectionIsListed;

/** The collection holding the "deleting" marker; the marker survives the wipe and goes last. */
export const DELETION_COLLECTION = 'accountDeletions' satisfies Collection;

const requireOwner = (ownerId: string): string => {
  if (ownerId.trim() === '') throw new Error('an owner id is required');
  return ownerId;
};

const count = (rows: Array<{ n?: unknown }>): number => Number(rows[0]?.n ?? 0);

/**
 * Owner-scoped tables that are not `Store` collections: the memory items (migration 0044) and their topic summaries (0050), the relations between people (0048), the
 * identity graph (memory-graph, migration 0043) and the versioned skills (0049). Children first, so a delete never meets a foreign key:
 * items and relations before accounts and people, accounts before people, skill versions before skill definitions.
 */
export const OWNER_TABLES = ['memory_topic_summaries', 'memory_items', 'relations', 'skill_versions', 'skill_defs', 'accounts', 'people'] as const;

async function deleteTableRows(db: DurableDb, table: string, ownerId: string, removed: Record<string, number>): Promise<void> {
  const found = count(await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`, [ownerId]));
  if (found === 0) return;
  await db.query(`DELETE FROM ${table} WHERE owner_id = ?`, [ownerId]);
  removed[table] = found;
}

/** Delete every row of `ownerId` in every collection (except the deletion marker) and in every owner table; returns the rows removed per table. */
export async function deleteOwnerRows(db: DurableDb, ownerId: string): Promise<Record<string, number>> {
  requireOwner(ownerId);
  const removed: Record<string, number> = {};
  for (const collection of COLLECTION_NAMES) {
    if (collection === DELETION_COLLECTION) continue;
    await deleteTableRows(db, tableFor(collection), ownerId, removed);
  }
  for (const table of OWNER_TABLES) await deleteTableRows(db, table, ownerId, removed);
  return removed;
}

/** Delete the owner's event log except the event types in `keepTypes` (the delete tombstones other open devices still have to read). */
export async function deleteOwnerEvents(db: DurableDb, ownerId: string, keepTypes: readonly string[]): Promise<number> {
  requireOwner(ownerId);
  const keep = keepTypes.length === 0 ? '' : ` AND type NOT IN (${keepTypes.map(() => '?').join(', ')})`;
  const found = count(await db.query(`SELECT COUNT(*) AS n FROM events WHERE owner_id = ?${keep}`, [ownerId, ...keepTypes]));
  if (found > 0) await db.query(`DELETE FROM events WHERE owner_id = ?${keep}`, [ownerId, ...keepTypes]);
  return found;
}

/** What closing the sign-in removed. */
export interface AuthClosed {
  sessions: number;
  accounts: number;
  deviceCodes: number;
  verifications: number;
}

/**
 * Sign the user out everywhere and take away every way to sign in again (their password row, device codes, reset tokens),
 * keeping the user row itself until the very end. Better Auth table names are fixed by account-auth.ts (`auth_` prefix).
 */
export async function closeAuthAccount(db: DurableDb, userId: string): Promise<AuthClosed> {
  requireOwner(userId);
  const email = String((await db.query<{ email: string }>('SELECT email FROM auth_user WHERE id = ?', [userId]))[0]?.email ?? '');
  const sweep = async (table: string, where: string, params: string[]): Promise<number> => {
    const found = count(await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params));
    if (found > 0) await db.query(`DELETE FROM ${table} WHERE ${where}`, params);
    return found;
  };
  return {
    sessions: await sweep('auth_session', '"userId" = ?', [userId]),
    accounts: await sweep('auth_account', '"userId" = ?', [userId]),
    deviceCodes: await sweep('"auth_deviceCode"', '"userId" = ?', [userId]),
    verifications: await sweep('auth_verification', email === '' ? 'value = ?' : 'value = ? OR identifier = ?', email === '' ? [userId] : [userId, email]),
  };
}

/** Delete the user row (after `closeAuthAccount`); true when there was one. */
export async function deleteAuthUser(db: DurableDb, userId: string): Promise<boolean> {
  requireOwner(userId);
  const found = count(await db.query('SELECT COUNT(*) AS n FROM auth_user WHERE id = ?', [userId]));
  if (found > 0) await db.query('DELETE FROM auth_user WHERE id = ?', [userId]);
  return found > 0;
}

const BLOB_TABLES = ['library', 'artifact_files', 'document_drafts', 'transcripts'] as const;
const KEYS_PER_SCAN = 50;

/**
 * Blobs are content-addressed, so two accounts that stored the same bytes share one object. Of `keys`, the ones some OTHER owner's
 * row still names (an upload, an artifact file, a transcript image); those objects must stay. One scan per table per 50 keys
 * (`LIKE` over the document text, so a `_` in a key only ever errs towards keeping the object).
 */
export async function blobKeysUsedByOthers(db: DurableDb, ownerId: string, keys: readonly string[]): Promise<Set<string>> {
  requireOwner(ownerId);
  const used = new Set<string>();
  for (let start = 0; start < keys.length; start += KEYS_PER_SCAN) {
    const chunk = keys.slice(start, start + KEYS_PER_SCAN);
    const flags = chunk.map((_, index) => `MAX(CASE WHEN CAST(doc AS TEXT) LIKE ? THEN 1 ELSE 0 END) AS k${String(index)}`).join(', ');
    for (const table of BLOB_TABLES) {
      const [row] = await db.query<Record<string, unknown>>(`SELECT ${flags} FROM ${table} WHERE owner_id <> ?`, [...chunk.map((key) => `%${key}%`), ownerId]);
      chunk.forEach((key, index) => { if (Number(row?.[`k${String(index)}`] ?? 0) > 0) used.add(key); });
    }
  }
  return used;
}
