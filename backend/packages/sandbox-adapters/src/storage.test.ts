import { describe, expect, it } from 'vitest';
import { computerSize, loadComputerConfig } from './config.js';
import type { DockerCli } from './docker-cli.js';
import { MANAGED_LABEL, OWNER_LABEL, ownerHash } from './local-container.js';
import { MOUNT_SCRIPT, computerStorage, createComputerStorage, fileSystemName, juicefsTargets, mountEnv, userMeta, volumeNames, type JuicefsSettings } from './storage.js';

const juicefsEnv = {
  COMPUTER_PROVIDER: 'e2b',
  COMPUTER_STORAGE: 'juicefs',
  STORAGE_META_URL: 'postgres://jfs:p%40ss%2Fword@db.internal:5432/juicefs_meta?sslmode=require',
  STORAGE_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
  STORAGE_S3_BUCKET: 'juno-files',
  STORAGE_S3_ACCESS_KEY: 'AKIAEXAMPLE',
  STORAGE_S3_SECRET_KEY: 'sekret-value',
};

function juicefs(): JuicefsSettings {
  const settings = computerStorage(loadComputerConfig(juicefsEnv));
  if (settings.kind !== 'juicefs') throw new Error('expected juicefs');
  return settings;
}

describe('storage config', () => {
  it('defaults to local volumes for local Docker and to the computer disk elsewhere', () => {
    expect(computerStorage(loadComputerConfig({ COMPUTER_PROVIDER: 'local' })).kind).toBe('local-volume');
    expect(computerStorage(loadComputerConfig({ COMPUTER_PROVIDER: 'e2b' })).kind).toBe('none');
  });

  it('refuses inconsistent settings at load time', () => {
    expect(() => loadComputerConfig({ COMPUTER_PROVIDER: 'e2b', COMPUTER_STORAGE: 'local-volume' })).toThrow(/only works with COMPUTER_PROVIDER=local/);
    expect(() => loadComputerConfig({ COMPUTER_STORAGE: 'juicefs' })).toThrow(/STORAGE_META_URL.*STORAGE_S3_BUCKET.*STORAGE_S3_ENDPOINT/s);
  });

  it('builds the bucket URL from endpoint and bucket', () => {
    expect(juicefs().bucket).toBe('https://acct.r2.cloudflarestorage.com/juno-files');
  });

  it('sizes local Docker at 2 vCPU / 4 GB and everything else at 2 / 2 unless configured', () => {
    expect(computerSize(loadComputerConfig({ COMPUTER_PROVIDER: 'local' }))).toEqual({ vcpu: 2, ramGb: 4 });
    expect(computerSize(loadComputerConfig({ COMPUTER_PROVIDER: 'e2b' }))).toEqual({ vcpu: 2, ramGb: 2 });
    expect(computerSize(loadComputerConfig({ COMPUTER_PROVIDER: 'local', COMPUTER_RAM_GB: '8' })).ramGb).toBe(8);
  });
});

describe('JuiceFS mount', () => {
  it('gives each owner its own file system, schema and volumes', () => {
    expect(fileSystemName('u1')).not.toBe(fileSystemName('u2'));
    expect(userMeta(juicefs(), 'u1').url).not.toBe(userMeta(juicefs(), 'u2').url);
    expect(volumeNames('u1').home).not.toBe(volumeNames('u2').home);
    expect(userMeta(juicefs(), 'u1').url).toMatch(/search_path=jfs_[0-9a-f]{16}/);
  });

  it('moves the metadata password out of the URL into META_PASSWORD', () => {
    const meta = userMeta(juicefs(), 'u1');
    expect(meta.password).toBe('p@ss/word');
    expect(meta.url).not.toContain('word');
    expect(meta.url).toContain('sslmode=require');
  });

  it('keeps every secret out of the script text; they travel only in the environment', () => {
    const env = mountEnv(juicefs(), 'u1');
    for (const secret of ['AKIAEXAMPLE', 'sekret-value', 'p@ss/word']) {
      expect(MOUNT_SCRIPT).not.toContain(secret);
      expect(Object.values(env)).toContain(secret);
      expect(env['JFS_META_URL']).not.toContain(secret);
    }
    expect(MOUNT_SCRIPT).not.toMatch(/--(access|secret)-key/);
  });
});

describe('deleting an owner\'s JuiceFS storage (account deletion)', () => {
  const signal = new AbortController().signal;

  it('derives one plain folder and one schema from the owner id alone, different for every owner', () => {
    const [a, b] = [juicefsTargets('user-a'), juicefsTargets('user-b')];
    expect(a.prefix).toMatch(/^juno-[0-9a-f]{16}\/$/);
    expect(a.schema).toMatch(/^jfs_[0-9a-f]{16}$/);
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.schema).not.toBe(b.schema);
    expect(() => juicefsTargets('')).toThrow('an owner id is required');
    expect(() => juicefsTargets('   ')).toThrow('an owner id is required');
  });

  it('deletes the objects first, then the metadata schema, only for that owner, and again harmlessly', async () => {
    const calls: string[] = [];
    const storage = createComputerStorage(juicefs(), {
      deleteObjects: async (prefix) => { calls.push(`objects ${prefix}`); return 3; },
      dropMeta: async (schema) => { calls.push(`schema ${schema}`); },
    });
    const { prefix, schema } = juicefsTargets('user-a');
    expect(await storage.purge?.('user-a', signal)).toEqual([`3 objects under ${prefix}`, `metadata schema ${schema}`]);
    expect(calls).toEqual([`objects ${prefix}`, `schema ${schema}`]);
    expect(await storage.purge?.('user-a', signal)).toHaveLength(2);
  });

  it('does not touch a SQLite metadata file (tests), and local volumes have no object store to purge', async () => {
    const settings: JuicefsSettings = { ...juicefs(), metaUrl: 'sqlite3:///tmp/meta.db' };
    let dropped = false;
    const storage = createComputerStorage(settings, { dropMeta: async () => { dropped = true; } });
    expect(await storage.purge?.('user-a', signal)).toEqual([]);
    expect(dropped).toBe(false);
    expect(createComputerStorage({ kind: 'local-volume' }).purge).toBeUndefined();
    expect(createComputerStorage({ kind: 'none' }).purge).toBeUndefined();
  });
});

describe('deleting an owner\'s local volumes (account deletion)', () => {
  const signal = new AbortController().signal;

  /** A docker CLI holding volumes by name; Docker prints `Labels`, Apple `container` prints `configuration.labels`. */
  function fakeVolumes(volumes: Record<string, Record<string, string>>, options: { apple?: boolean; busy?: string } = {}) {
    const calls: string[][] = [];
    const docker: DockerCli = {
      async run(args) {
        calls.push(args);
        const name = args[2] ?? '';
        if (args[1] === 'inspect') {
          const labels = volumes[name];
          if (labels === undefined) return { exitCode: 1, stdout: '[]', stderr: options.apple ? `volume ${name} not found` : `Error response from daemon: get ${name}: no such volume` };
          return { exitCode: 0, stderr: '', stdout: JSON.stringify([options.apple ? { configuration: { labels }, id: name } : { Name: name, Labels: labels }]) };
        }
        if (args[1] === 'rm') {
          if (name === options.busy) return { exitCode: 1, stdout: '', stderr: `volume is in use - [abc]` };
          delete volumes[name];
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    return { calls, docker };
  }
  const labelsOf = (owner: string) => ({ [OWNER_LABEL]: ownerHash(owner), [MANAGED_LABEL]: '1' });
  const storage = createComputerStorage({ kind: 'local-volume' });

  it.each([{ apple: false }, { apple: true }])('removes the owner\'s own volumes and nothing else (apple: $apple)', async ({ apple }) => {
    const mine = volumeNames('user-a');
    const volumes: Record<string, Record<string, string>> = {
      [mine.home]: labelsOf('user-a'), [mine.workspace]: labelsOf('user-a'), [mine.profiles]: labelsOf('user-a'),
      [volumeNames('user-b').home]: labelsOf('user-b'),
    };
    const { calls, docker } = fakeVolumes(volumes, { apple });
    expect(await storage.removeVolumes?.(docker, 'user-a', signal)).toEqual([mine.home, mine.workspace, mine.profiles]);
    expect(Object.keys(volumes)).toEqual([volumeNames('user-b').home]);
    expect(calls.filter((call) => call[1] === 'rm').map((call) => call[2])).toEqual([mine.home, mine.workspace, mine.profiles]);
    // Gone already is fine.
    expect(await storage.removeVolumes?.(docker, 'user-a', signal)).toEqual([]);
  });

  it('leaves a volume of that name alone when it is not labelled as this owner\'s, or not as managed', async () => {
    const mine = volumeNames('user-a');
    const volumes: Record<string, Record<string, string>> = {
      [mine.home]: labelsOf('user-b'), // another owner's label
      [mine.workspace]: {}, // no labels: made by hand
      [mine.profiles]: { [OWNER_LABEL]: ownerHash('user-a') }, // not marked managed
    };
    const { calls, docker } = fakeVolumes(volumes);
    expect(await storage.removeVolumes?.(docker, 'user-a', signal)).toEqual([]);
    expect(calls.some((call) => call[1] === 'rm')).toBe(false);
    expect(Object.keys(volumes)).toHaveLength(3);
  });

  it('fails when a volume is still in use, so the deletion is retried after the computer is gone', async () => {
    const mine = volumeNames('user-a');
    const { docker } = fakeVolumes({ [mine.home]: labelsOf('user-a') }, { busy: mine.home });
    await expect(storage.removeVolumes?.(docker, 'user-a', signal)).rejects.toThrow(/could not remove volume .*in use/);
  });
});
