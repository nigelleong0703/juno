/**
 * Restart persistence of the computer binding. The failure this guards against is subtle: if a seed
 * only lived in memory, removing \`E2B_SANDBOX_ID\` after a restart would create a SECOND VM. The file
 * must be the source of truth, written atomically and read fail-fast.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComputerStateStore } from '../infrastructure/computer-state.js';

const paths: string[] = [];
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-state-'));
  paths.push(dir);
  return join(dir, 'binding.json');
};

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('computer binding persistence', () => {
  it('persists a seed so a later restart without the seed reuses the same sandbox', () => {
    const file = tempFile();
    const first = createComputerStateStore(file, { sandboxId: 'sbx-seed', template: 'desktop-debian' });
    expect(first.get()).toEqual({ sandboxId: 'sbx-seed', template: 'desktop-debian' });
    // The seed reached disk immediately, not only on a new create.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ sandboxId: 'sbx-seed' });

    const restarted = createComputerStateStore(file, null);
    expect(restarted.get()).toEqual({ sandboxId: 'sbx-seed', template: 'desktop-debian' });
  });

  it('round-trips a binding written by create', () => {
    const file = tempFile();
    const store = createComputerStateStore(file, null);
    expect(store.get()).toBeNull();
    store.set({ sandboxId: 'sbx-new', template: 'desktop-debian' });
    expect(createComputerStateStore(file, null).get()).toEqual({ sandboxId: 'sbx-new', template: 'desktop-debian' });
  });

  it('fails fast on a corrupt file instead of silently starting a new VM', () => {
    const file = tempFile();
    writeFileSync(file, '{ not json');
    expect(() => createComputerStateStore(file, { sandboxId: 'sbx-seed', template: 'desktop-debian' })).toThrow(/corrupt/);
  });

  it('fails fast when the binding path is unreadable or unwritable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-state-'));
    paths.push(dir);
    const unwritable = join(dir, 'as-directory');
    mkdirSync(unwritable); // a directory cannot be overwritten by writeFileSync
    expect(() => createComputerStateStore(unwritable, { sandboxId: 'x', template: 't' })).toThrow(/could not (read|persist)/);
  });
});
