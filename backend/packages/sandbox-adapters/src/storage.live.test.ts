/**
 * LIVE durable storage (BACKEND 7.10) against real throwaway containers of the local desktop image. Skipped unless
 * LIVE_DOCKER=1 (needs Docker, the image `juno-desktop:local` and, for JuiceFS, network access for apt and the JuiceFS
 * release). Everything it creates (containers, volumes, the derived JuiceFS test image, host temp dirs) it removes.
 *
 *   LIVE_DOCKER=1 pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/storage.live.test.ts
 *
 * - local-volume: the container is deleted and rebuilt for the same user; files, owners and modes survive and the
 *   per-agent isolation (BACKEND 7.9) still holds on the new computer.
 * - juicefs: no S3, no MinIO. JuiceFS uses a host directory as object storage (`--storage file`) and SQLite as metadata,
 *   in a container built exactly like the image template (fuse3 + the pinned `install-juicefs.sh`). Mounted by the real
 *   `attach` as root, written as agents, container deleted, a fresh container mounts the same data.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import { createDockerCli } from './docker-cli.js';
import { agentUser, applyHomeOwnership } from './isolation.js';
import { MANAGED_LABEL, OWNER_LABEL, ownerHash } from './local-container.js';
import type { SandboxRuntime } from './runtime.js';
import { createLinkRuntime } from './link-runtime.js';
import { liveImage, startLiveLink, type LiveLink } from './live-link.js';
import { createLocalProvider } from './local.js';
import { createComputerStorage, volumeNames, type ComputerStorage, type JuicefsSettings } from './storage.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;
const docker = (...args: string[]) => execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const dockerQuiet = (...args: string[]) => {
  try {
    docker(...args);
  } catch {
    // Already gone.
  }
};
const signal = () => AbortSignal.timeout(300_000);
const A = 'agent-store-a';
const B = 'agent-store-b';

const host = { template: '', resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 };

/** The link endpoint every test here shares (a real hub on a real WebSocket server, in this process). */
let link: LiveLink;
if (process.env['LIVE_DOCKER'] === '1') {
  beforeAll(async () => {
    link = await startLiveLink();
  });
  afterAll(() => link?.close());
}

/** Drives one owner's computers: create / destroy / run as root or as an agent, on the real provider. */
function harness(ownerId: string, image: () => string, storage: ComputerStorage) {
  let made: ReturnType<typeof createLocalProvider> | undefined;
  const providerOf = () => (made ??= createLocalProvider({ ownerId, image: image(), storage, hub: link.hub, linkUrl: link.linkUrl }));
  const containers: string[] = [];
  return {
    containers,
    linkRuntime: (binding: E2bBinding) => createLinkRuntime({ hub: link.hub, linkId: binding.linkId ?? '' }),
    async create(): Promise<E2bBinding> {
      const binding = await providerOf().create({ ...host, template: image() }, signal());
      containers.push(binding.sandboxId);
      return binding;
    },
    destroy(binding: E2bBinding) {
      docker('rm', '-f', binding.sandboxId);
    },
    /** Account deletion on the real provider: the owner's computers and durable storage. */
    erase: (binding: E2bBinding | null) => providerOf().erase?.(binding, signal()),
    root: (binding: E2bBinding, command: string) =>
      providerOf().withRuntime(binding, signal(), async (runtime) => {
        const result = await runtime.run(command, { cwd: '/' });
        return { out: result.stdout, err: result.stderr, code: result.exitCode };
      }, { user: 'root' }),
    withRoot: <T>(binding: E2bBinding, fn: (runtime: SandboxRuntime) => Promise<T>) => providerOf().withRuntime(binding, signal(), fn, { user: 'root' }),
    async agent(binding: E2bBinding, agentId: string, command: string) {
      await providerOf().environment(binding, signal(), agentId); // creates the agent's user on first use
      const result = await providerOf().act(binding, agentId, 1, { kind: 'shell', input: { command, timeoutMs: 60_000 } }, signal());
      if (!result.shell) throw new Error('no shell result');
      return { out: result.shell.stdout, err: result.shell.stderr, code: result.shell.exitCode };
    },
    dispose: () => made?.dispose(),
  };
}

const SNAPSHOT = "find /juno /workspace -printf '%p %u:%g uid=%U gid=%G %m\\n' | grep -v '/.juno-sync' | sort";

/** Files and modes both storage backends must keep, written as root (the platform) and as the agents. */
async function writeFixture(h: ReturnType<typeof harness>, binding: E2bBinding) {
  await h.root(binding, 'mkdir -p /juno/agents/' + A + ' /juno/agents/' + B + ' && echo "A soul" > /juno/agents/' + A + '/SOUL.md && echo "B soul" > /juno/agents/' + B + '/SOUL.md && echo shared-memory > /juno/MEMORY.md');
  // Create B before A on purpose; the rebuilt computer creates them in the other order (uids must not depend on it).
  expect((await h.agent(binding, B, 'echo from-b > /workspace/b.txt && mkdir -p /workspace/dir && echo inner > /workspace/dir/x.txt')).code).toBe(0);
  expect((await h.agent(binding, A, 'echo from-a > /workspace/a.txt')).code).toBe(0);
  // The platform's own ownership rules for /juno (BACKEND 7.9), exactly as home writes and the migration apply them.
  await h.withRoot(binding, (runtime) => applyHomeOwnership(runtime, ''));
}

async function expectIsolation(h: ReturnType<typeof harness>, binding: E2bBinding) {
  expect((await h.agent(binding, A, `cat /juno/agents/${A}/SOUL.md /juno/MEMORY.md`)).out).toContain('A soul');
  const denied = await h.agent(binding, B, `cat /juno/agents/${A}/SOUL.md`);
  expect(denied.code).not.toBe(0);
  expect(denied.err).toContain('Permission denied');
  expect((await h.agent(binding, B, 'cat /workspace/a.txt && echo more >> /workspace/a.txt')).code).toBe(0);
  expect((await h.agent(binding, A, 'echo hacked > /juno/MEMORY.md')).code).not.toBe(0);
}

live('durable storage: local-volume', () => {
  const owner = 'live-storage-vol-' + randomUUID().slice(0, 8);
  const h = harness(owner, liveImage, createComputerStorage({ kind: 'local-volume' }));

  afterAll(() => {
    for (const id of h.containers) dockerQuiet('rm', '-f', id);
    const names = volumeNames(owner);
    dockerQuiet('volume', 'rm', '-f', names.home, names.workspace, names.profiles);
    h.dispose();
  }, 120_000);

  it('keeps files, owners and modes when the container is deleted and rebuilt, and isolation still holds', async () => {
    const first = await h.create();
    await writeFixture(h, first);
    await expectIsolation(h, first);
    const before = (await h.root(first, SNAPSHOT)).out;
    expect(before).toContain('/workspace/dir/x.txt');
    h.destroy(first);

    const second = await h.create();
    expect(second.sandboxId).not.toBe(first.sandboxId);
    // The new computer is a blank one: agent users are created again, in the other order.
    expect((await h.agent(second, A, 'id -un')).out.trim()).toBe(agentUser(A));
    expect((await h.agent(second, B, 'id -un')).out.trim()).toBe(agentUser(B));
    const after = (await h.root(second, SNAPSHOT)).out;
    expect(after).toBe(before);
    expect((await h.root(second, 'cat /workspace/dir/x.txt /juno/agents/' + A + '/SOUL.md')).out).toContain('inner');
    await expectIsolation(h, second);
  }, 600_000);

  it('account deletion removes every computer and volume of the owner (the stored one and a stray), and nothing of another owner', async () => {
    const bystander = 'live-storage-bystander-' + randomUUID().slice(0, 8);
    const bystanderVolumes = volumeNames(bystander);
    const cli = createDockerCli();
    try {
      // Another owner with volumes of the same kind and a stopped container that carries ITS labels: both must survive.
      await createComputerStorage({ kind: 'local-volume' }).dockerArgs(cli, bystander, signal());
      docker('create', '--name', 'live-bystander-' + bystander, '--label', `${OWNER_LABEL}=${ownerHash(bystander)}`, '--label', `${MANAGED_LABEL}=1`, '-v', `${bystanderVolumes.home}:/juno`, liveImage());
      const stored = await h.create();
      await h.root(stored, 'echo to-be-erased > /workspace/gone.txt');
      const volumesOf = () => docker('volume', 'ls', '-q').split('\n');
      expect(volumesOf()).toContain(volumeNames(owner).workspace);

      const report = await h.erase(stored);
      expect(report?.computers).toBeGreaterThanOrEqual(2); // the stored one and the one the previous test left (found by its labels)
      expect(report?.removed.sort()).toEqual(Object.values(volumeNames(owner)).map((name) => `volume ${name}`).sort());
      for (const id of h.containers) expect(() => docker('inspect', id)).toThrow();
      for (const name of Object.values(volumeNames(owner))) expect(volumesOf()).not.toContain(name);
      expect(volumesOf()).toEqual(expect.arrayContaining(Object.values(bystanderVolumes)));
      expect(docker('inspect', '-f', '{{.Name}}', 'live-bystander-' + bystander).trim()).toBe('/live-bystander-' + bystander);

      // Nothing is left to remove, and running it again is fine.
      expect(await h.erase(null)).toEqual({ computers: 0, removed: [] });
    } finally {
      dockerQuiet('rm', '-f', 'live-bystander-' + bystander);
      dockerQuiet('volume', 'rm', '-f', bystanderVolumes.home, bystanderVolumes.workspace, bystanderVolumes.profiles);
    }
  }, 600_000);
});

const JUICEFS_TEST_IMAGE = 'agent-juicefs-test:' + randomUUID().slice(0, 8);

live('durable storage: juicefs (file objects + SQLite, no S3)', () => {
  let dataDir = '';
  const metaVolume = 'juno-jfs-test-meta-' + randomUUID().slice(0, 8);
  const owner = 'live-storage-jfs-' + randomUUID().slice(0, 8);
  const settings: JuicefsSettings = {
    kind: 'juicefs',
    metaUrl: 'sqlite3:///jfs-meta/meta.db',
    objectStorage: 'file',
    bucket: '/jfs-data/',
    accessKey: '',
    secretKey: '',
  };
  const base = createComputerStorage(settings);
  // The only test-specific part: the object directory comes from the host and the SQLite file from a volume (both mounted by docker).
  const storage: ComputerStorage = {
    ...base,
    dockerArgs: async (cli, ownerId, sig) => [...(await base.dockerArgs(cli, ownerId, sig)), '-v', `${dataDir}:/jfs-data`, '-v', `${metaVolume}:/jfs-meta`],
  };
  const h = harness(owner, () => JUICEFS_TEST_IMAGE, storage);

  beforeAll(() => {
    // Build the image like the template does: fuse3 from apt and the pinned installer script (a committed throwaway container).
    dataDir = mkdtempSync(join(tmpdir(), 'juno-jfs-data-'));
    docker('volume', 'create', metaVolume);
    const prep = 'agent-juicefs-prep-' + randomUUID().slice(0, 8);
    docker('run', '-d', '--name', prep, '--user', 'root', liveImage(), 'sleep', '600');
    try {
      docker('cp', resolve(__dirname, '../../sandbox-image/files/storage/install-juicefs.sh'), `${prep}:/tmp/install-juicefs.sh`);
      docker('exec', '-u', 'root', prep, 'sh', '-c', 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends fuse3 && sh /tmp/install-juicefs.sh');
      // The committed container carries the throwaway `sleep` it was started with; the image must start the daemon.
      docker('commit', '--change', 'CMD ["/usr/local/bin/juno-link"]', prep, JUICEFS_TEST_IMAGE);
    } finally {
      dockerQuiet('rm', '-f', prep);
    }
  }, 600_000);

  afterAll(() => {
    for (const id of h.containers) dockerQuiet('rm', '-f', id);
    dockerQuiet('rmi', JUICEFS_TEST_IMAGE);
    dockerQuiet('volume', 'rm', '-f', metaVolume);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    h.dispose();
  }, 120_000);

  it('mounts as root, keeps owners and modes across a rebuilt computer, and hides the mount internals from agents', async () => {
    const first = await h.create();
    const mounts = (await h.root(first, 'mount | grep -E "JuiceFS|/juno|/workspace"; juicefs version')).out;
    expect(mounts).toContain('JuiceFS');
    await h.root(first, 'chmod 0700 /jfs-meta'); // the SQLite file stands in for the credentials a Postgres/S3 deployment would hold
    await writeFixture(h, first);
    await expectIsolation(h, first);
    const before = (await h.root(first, SNAPSHOT)).out;
    expect(before).toContain('/workspace/dir/x.txt');

    // Agents cannot reach the mount internals: the root-only store, the metadata, the daemon's environment.
    const spy = await h.agent(first, A, 'ls /run/juno-private 2>&1; ls /jfs-meta 2>&1; for p in $(pgrep -f "juicefs mount"); do cat /proc/$p/environ 2>&1 | head -c 200; done; ps -eo args | grep "[j]uicefs mount"');
    expect(spy.out).toContain('Permission denied');
    expect(spy.out).not.toMatch(/JFS_META_URL=|META_PASSWORD=/);
    const argv = (await h.root(first, 'ps -eo args | grep "[j]uicefs mount"')).out;
    expect(argv).toContain('juicefs mount');
    expect(argv).not.toMatch(/--(access|secret)-key|password/i);

    // Unmount cleanly, then delete the computer.
    expect((await h.root(first, 'cd / && umount /juno && umount /workspace && umount /run/juno-private/store; echo unmounted=$?')).out).toContain('unmounted=0');
    h.destroy(first);

    const second = await h.create();
    expect((await h.agent(second, A, 'id -un')).out.trim()).toBe(agentUser(A));
    expect((await h.agent(second, B, 'id -un')).out.trim()).toBe(agentUser(B));
    const after = (await h.root(second, SNAPSHOT)).out;
    expect(after).toBe(before);
    await expectIsolation(h, second);
    // attach is idempotent: running it again changes nothing.
    await storage.attach(h.linkRuntime(second), owner);
    expect((await h.root(second, SNAPSHOT)).out).toBe(before);
  }, 900_000);
});
