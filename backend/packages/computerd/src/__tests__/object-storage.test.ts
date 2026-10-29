import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteFolder, objectDeleter } from '../infrastructure/object-storage.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function bucket(): string {
  const root = mkdtempSync(join(tmpdir(), 'object-storage-'));
  dirs.push(root);
  const dir = join(root, 'bucket');
  for (const folder of ['juno-0123456789abcdef', 'juno-fedcba9876543210', 'blobs']) {
    mkdirSync(join(dir, folder, 'chunks'), { recursive: true });
    writeFileSync(join(dir, folder, 'chunks', '0'), 'x');
  }
  writeFileSync(join(root, 'outside.txt'), 'keep');
  return dir;
}

describe('deleting a directory-backed object folder', () => {
  it('removes that folder and no other folder, the shared blobs or anything outside the bucket', async () => {
    const dir = bucket();
    expect(deleteFolder(dir, 'juno-0123456789abcdef/')).toBe(2);
    expect(existsSync(join(dir, 'juno-0123456789abcdef'))).toBe(false);
    for (const kept of ['juno-fedcba9876543210/chunks/0', 'blobs/chunks/0', '../outside.txt']) expect(existsSync(join(dir, kept))).toBe(true);
    expect(deleteFolder(dir, 'juno-0123456789abcdef/')).toBe(0);
    expect(await objectDeleter({ STORAGE_TYPE: 'file', STORAGE_S3_BUCKET: dir, STORAGE_S3_ENDPOINT: '', STORAGE_S3_ACCESS_KEY: '', STORAGE_S3_SECRET_KEY: '' })('juno-fedcba9876543210/')).toBe(2);
  });

  it('refuses anything that is not one plain folder name', () => {
    const dir = bucket();
    for (const prefix of ['', '/', '../', './', '..', 'juno-x', 'a/b/', '../bucket/', '/etc/']) {
      expect(() => deleteFolder(dir, prefix)).toThrow('refusing to delete');
    }
    expect(existsSync(join(dir, 'juno-0123456789abcdef', 'chunks', '0'))).toBe(true);
  });
});
