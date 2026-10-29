/**
 * Production settings writer.
 *
 * A read-modify-write needs a lock that spans both statements on one connection, and the global
 * document Store does not expose its transaction. This adapter takes a dedicated client from the
 * pool, opens an explicit transaction and serialises writers for one owner with a transaction
 * advisory lock, so concurrent PATCHes from multiple processes cannot lose an update.
 */
import type { Pool } from 'pg';
import type { AppSettings, UpdateSettingsInput } from '@agent-desktop/public-contracts';
import { mergeSettings, settingsIdFor, type SettingsUpdater } from './settings.js';

/** Advisory-lock namespace for settings rows (keeps the key clear of other lock users). */
const SETTINGS_LOCK_CLASS = 8412;

const UPSERT_SETTINGS = [
  'INSERT INTO settings (id, owner_id, doc, updated_at)',
  'VALUES ($1, $2, $3, NOW())',
  'ON CONFLICT (id) DO UPDATE',
  '  SET owner_id = EXCLUDED.owner_id,',
  '      doc = EXCLUDED.doc, updated_at = NOW()',
  '  WHERE settings.owner_id = $2',
  'RETURNING id',
].join(' ');

export function createPostgresSettingsUpdater(pool: Pool): SettingsUpdater {
  return async (ownerId: string, patch: UpdateSettingsInput): Promise<AppSettings> => {
    const id = settingsIdFor(ownerId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [SETTINGS_LOCK_CLASS, id]);
      const existing = await client.query('SELECT doc FROM settings WHERE id = $1 AND owner_id = $2 LIMIT 1', [
        id,
        ownerId,
      ]);
      const current: unknown = existing.rows[0]?.doc ?? null;
      const merged = mergeSettings(current, patch);
      const doc = { id, ...merged };
      const written = await client.query(UPSERT_SETTINGS, [
        id,
        ownerId,
        JSON.stringify(doc),
      ]);
      if (written.rows.length === 0) throw new Error('settings id belongs to another owner: ' + id);
      await client.query('COMMIT');
      return merged;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}
