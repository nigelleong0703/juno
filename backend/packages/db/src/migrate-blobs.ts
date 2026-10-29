/**
 * One-off, idempotent move of file bytes out of Postgres into the blob store (BACKEND §5.2a):
 *
 *  - `library` rows with `contentBase64` (uploads, send_file, approval previews) and `artifact_files` rows get a
 *    `blobKey` (and `sha256` when they had none); `contentBase64` is removed.
 *  - `transcripts` rows whose user or tool-result images carry base64 get the `{ data: '', blobKey }` reference.
 *
 * Every row is rewritten only after its bytes are stored, so an interrupted run is simply run again. It runs with the
 * same BLOB_STORE / BLOB_DIR / STORAGE_S3_* the services use (root .env loaded when present), then reclaim the space
 * with `VACUUM FULL library, artifact_files, transcripts`.
 *
 *   pnpm --filter @agent-desktop/db blobs:migrate
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { saveBlob, type BlobStore } from '@agent-desktop/contracts';
import { offloadImages } from 'juno-agent/execution/brain/transcript-images';
import { createBlobStore } from './blobs.js';
import { openPostgres, type Sql } from './connection.js';
import { requireDatabaseUrl } from './db-config.js';
import { isRecord, toJsonValue } from './guards.js';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

type Rewrite = (doc: Record<string, unknown>, blobs: BlobStore) => Promise<Record<string, unknown> | null>;

/** A file row: its base64 goes to the blob store, the row keeps blobKey + sha256. */
const fileRow: Rewrite = async (doc, blobs) => {
  const base64 = doc['contentBase64'];
  if (typeof base64 !== 'string') return null;
  const { contentBase64: _bytes, ...rest } = doc;
  const mimeType = typeof doc['mimeType'] === 'string' ? doc['mimeType'] : 'application/octet-stream';
  const stored = await saveBlob(blobs, Buffer.from(base64, 'base64'), mimeType);
  return { ...rest, blobKey: stored.blobKey, sha256: typeof doc['sha256'] === 'string' ? doc['sha256'] : stored.sha256 };
};

type Message = Parameters<typeof offloadImages>[1];
const isMessage = (value: unknown): value is Message => isRecord(value) && typeof value['role'] === 'string';

/** A transcript row: inline images become blob references (the same form new rows are written in). */
const transcriptRow: Rewrite = async (doc, blobs) => {
  const message = doc['message'];
  if (!isMessage(message)) return null;
  const moved = await offloadImages(blobs, message);
  return moved === message ? null : { ...doc, message: moved };
};

async function migrateTable(sql: Sql, blobs: BlobStore, table: string, filter: string, rewrite: Rewrite): Promise<number> {
  // Ids first, then one row at a time: a row can hold megabytes of base64.
  const ids = await sql.unsafe<Array<{ id: string }>>(`SELECT id FROM ${table} WHERE ${filter}`);
  let moved = 0;
  for (const { id } of ids) {
    const [row] = await sql.unsafe<Array<{ doc: unknown }>>(`SELECT doc FROM ${table} WHERE id = $1`, [id]);
    if (row === undefined || !isRecord(row.doc)) continue;
    const next = await rewrite(row.doc, blobs);
    if (next === null) continue;
    await sql`UPDATE ${sql(table)} SET doc = ${sql.json(toJsonValue(next) ?? null)} WHERE id = ${id}`;
    moved += 1;
  }
  return moved;
}

async function main(): Promise<void> {
  const sql = openPostgres(requireDatabaseUrl());
  const blobs = createBlobStore(process.env);
  try {
    const library = await migrateTable(sql, blobs, 'library', `doc ? 'contentBase64'`, fileRow);
    const artifactFiles = await migrateTable(sql, blobs, 'artifact_files', `doc ? 'contentBase64'`, fileRow);
    const transcripts = await migrateTable(sql, blobs, 'transcripts', `doc::text LIKE '%"type": "image"%'`, transcriptRow);
    process.stdout.write(JSON.stringify({ library, artifactFiles, transcripts }) + '\n');
  } finally {
    await sql.end();
  }
}

await main();
