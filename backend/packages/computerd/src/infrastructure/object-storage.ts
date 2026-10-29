/**
 * Deleting a user's JuiceFS objects (account deletion, BACKEND §5.2c): the S3-compatible bucket from the storage settings, or the
 * directory that stands in for it in tests (`STORAGE_TYPE=file`). computerd owns the bucket credentials, so the delete lives here.
 * The caller passes the folder name `juno-<hash>/`; anything that is not one plain top-level folder is refused.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { deleteS3Prefix } from '@agent-desktop/db';
import type { ComputerConfig } from '@agent-desktop/sandbox-adapters';

type ObjectStorageConfig = Pick<ComputerConfig, 'STORAGE_TYPE' | 'STORAGE_S3_ENDPOINT' | 'STORAGE_S3_BUCKET' | 'STORAGE_S3_ACCESS_KEY' | 'STORAGE_S3_SECRET_KEY'>;

/** Remove one folder of a directory-backed object store; returns how many entries it held. */
export function deleteFolder(bucketDir: string, prefix: string): number {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(prefix)) throw new Error(`refusing to delete the object folder ${JSON.stringify(prefix)}`);
  const root = resolve(bucketDir);
  const folder = resolve(root, prefix);
  if (dirname(folder) !== root || basename(folder) !== prefix.slice(0, -1)) throw new Error(`refusing to delete outside ${root}`);
  if (!existsSync(folder)) return 0;
  const entries = readdirSync(folder, { recursive: true }).length;
  rmSync(folder, { recursive: true, force: true });
  return entries;
}

/** The function that deletes every object under a folder of the configured object store. */
export function objectDeleter(config: ObjectStorageConfig, env: NodeJS.ProcessEnv = process.env): (prefix: string) => Promise<number> {
  if (config.STORAGE_TYPE === 'file') return async (prefix) => deleteFolder(config.STORAGE_S3_BUCKET, prefix);
  return (prefix) => deleteS3Prefix({
    endpoint: config.STORAGE_S3_ENDPOINT,
    bucket: config.STORAGE_S3_BUCKET,
    accessKey: config.STORAGE_S3_ACCESS_KEY,
    secretKey: config.STORAGE_S3_SECRET_KEY,
    region: env['BLOB_S3_REGION'] ?? 'us-east-1',
  }, prefix);
}
