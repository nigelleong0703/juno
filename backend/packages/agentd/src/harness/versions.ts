/**
 * The Postgres side of the harness versions (migration 0053, BACKEND §11.2): the port juno-agent reads through, on the durable db handle
 * the other platform tables use (raw SQL, like platform skills).
 */
import type { DurableDb } from '@agent-desktop/durable';
import type { HarnessOrigin, HarnessVersion } from 'juno-agent/modules/harness/loader';
import type { HarnessStatus, HarnessVersionRow, HarnessVersionStore } from 'juno-agent/modules/harness/store';
import { z } from 'zod';

interface VersionRecord {
  id: string;
  parent_id: string | null;
  /** jsonb object (written as `?::text::jsonb`, migration 0054): the driver hands it back parsed. */
  files: unknown;
  origin: HarnessOrigin;
  status: HarnessStatus;
  note: string;
  created_at: Date | string;
}

const filesSchema = z.record(z.string(), z.string());

function toRow(record: VersionRecord): HarnessVersionRow {
  return {
    id: record.id,
    parentId: record.parent_id,
    files: filesSchema.parse(record.files),
    origin: record.origin,
    status: record.status,
    note: record.note,
    createdAt: new Date(record.created_at).toISOString(),
  };
}

export function createPostgresHarnessStore(db: DurableDb): HarnessVersionStore {
  return {
    async row(id) {
      const [record] = await db.query<VersionRecord>('SELECT * FROM harness_versions WHERE id = ?', [id]);
      return record === undefined ? undefined : toRow(record);
    },
    async active() {
      const [record] = await db.query<VersionRecord>("SELECT * FROM harness_versions WHERE status = 'active'");
      return record === undefined ? undefined : toRow(record);
    },
    async seedActive(version: HarnessVersion) {
      return db.transaction(async (tx) => {
        // The previous active row and any candidate are retired first: the partial unique index allows one active at a time.
        await tx.query("UPDATE harness_versions SET status = 'retired' WHERE status IN ('active', 'candidate') AND id <> ?", [version.id]);
        const [existing] = await tx.query<VersionRecord>('SELECT * FROM harness_versions WHERE id = ?', [version.id]);
        if (existing === undefined) {
          await tx.query(
            "INSERT INTO harness_versions (id, parent_id, files, origin, status, note) VALUES (?, NULL, ?::text::jsonb, 'seed', 'active', 'repository seed')",
            [version.id, JSON.stringify(version.files)],
          );
        } else {
          await tx.query("UPDATE harness_versions SET status = 'active' WHERE id = ?", [version.id]);
        }
        const [record] = await tx.query<VersionRecord>('SELECT * FROM harness_versions WHERE id = ?', [version.id]);
        if (record === undefined) throw new Error(`harness version ${version.id} was not written`);
        return toRow(record);
      });
    },
  };
}
