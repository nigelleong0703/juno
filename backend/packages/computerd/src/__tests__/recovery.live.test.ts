/**
 * LIVE self-healing of a lost computer (BACKEND §7.11, fault tolerance) with real containers and the real link:
 *  (a) a container removed behind computerd's back: the next shell + screenshot succeed transparently on a new container, the
 *      workspace file and the browser profile marker are intact, the old binding is archived, the audit event is written;
 *  (b) a stored binding without a link id for a container that does not exist: archived at startup, first use just works;
 *  (c) creates keep failing for a few attempts: the call is told the computer is being restored (`computer_recovering`), and
 *      the recovery goes on with backoff until it works.
 *
 * Skipped unless LIVE_DOCKER=1 (needs Docker, `juno-desktop:local`, Bun for the daemon binary: BUN=/path/to/bun).
 *
 *   BUN=/path/to/bun LIVE_DOCKER=1 pnpm --filter @agent-desktop/computerd exec vitest run src/__tests__/recovery.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { agentSchema } from '@agent-desktop/public-contracts';
import { agentUser, COMPUTER_RECREATED_HEADER, createComputerStorage, createLocalProvider, volumeNames } from '@agent-desktop/sandbox-adapters';
import { liveImage, startLiveLink, type LiveLink } from '@agent-desktop/sandbox-adapters/live-link';
import { ARCHIVE_DIR } from '../infrastructure/computer-state.js';
import { createOwnerComputers } from '../modules/computers/owner-computers.js';
import { createOwnerComputerApp } from '../transport/owner-routes.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const quiet = (...args: string[]) => { try { docker(...args); } catch { /* already gone */ } };
const hashOf = (owner: string) => createHash('sha256').update(owner).digest('hex');
const AGENT = 'agent-heal';
const agentRow = (owner: string) => agentSchema.parse({
  id: AGENT, name: 'Heal', handle: 'heal', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work',
  pinned: false, lastActivity: '', unreadCount: 0, channels: [], computerId: 'c', skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
  model: { planner: { provider: 'x', model: 'x' }, computer: { provider: 'x', model: 'x' }, fast: { provider: 'x', model: 'x' } },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: owner,
});

live('computer self-healing with real containers', () => {
  let link: LiveLink;
  let dir: string;
  let image: string;
  const owners: string[] = [];
  const providers: Array<{ dispose(): void }> = [];

  beforeAll(async () => {
    link = await startLiveLink();
    image = liveImage();
    dir = mkdtempSync(join(tmpdir(), 'heal-live-'));
  }, 900_000);

  afterAll(() => {
    for (const owner of owners) {
      for (const id of docker('ps', '-aq', '--filter', `label=dev.agent-desktop.owner=${hashOf(owner)}`).split('\n').filter(Boolean)) quiet('rm', '-f', id);
      const names = volumeNames(owner);
      quiet('volume', 'rm', '-f', names.home, names.workspace, names.profiles);
    }
    for (const provider of providers) provider.dispose();
    link?.close();
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  /** One owner's computerd: real provider, real link, files under `dir`. `failNext(n)` makes the next n creates use a missing image. */
  async function owner(options: { waitMs: number; seedBinding?: object }) {
    const name = 'heal-' + randomUUID().slice(0, 8);
    owners.push(name);
    const store = createMemoryStore();
    if (!store.forOwner) throw new Error('scoped store required');
    await store.forOwner(name).put('agents', agentRow(name));
    const bindingFile = join(dir, name, 'computerd-binding.json');
    const ownerFile = join(dirname(bindingFile), 'owners', hashOf(name), 'computerd-binding.json');
    if (options.seedBinding) {
      mkdirSync(dirname(ownerFile), { recursive: true });
      writeFileSync(ownerFile, JSON.stringify(options.seedBinding));
    }
    let failures = 0;
    const host = {
      get template() { return failures-- > 0 ? 'juno-image-that-does-not-exist:none' : image; },
      resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0,
    };
    const computers = createOwnerComputers({
      store, legacyOwnerId: '', bindingFile, poolFile: join(dir, name, 'screen-pool.json'), host, secret: 's',
      providerForOwner: (ownerId) => {
        const provider = createLocalProvider({ ownerId, image, storage: createComputerStorage({ kind: 'local-volume' }), hub: link.hub, linkUrl: link.linkUrl });
        providers.push(provider);
        return provider;
      },
      recovery: { waitMs: options.waitMs, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 500))) },
    });
    const app = createOwnerComputerApp({ computers, token: 'service' });
    const call = (path: string, body: unknown = {}) => app.request(path, {
      method: 'POST',
      headers: { authorization: 'Bearer service', 'x-owner-id': name, 'x-agent-id': AGENT, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const shell = async (command: string) => {
      const response = await call('/v1/screens/self/shell/run', { command, timeoutMs: 60_000 });
      return { response, body: (await response.json()) as { stdout?: string; code?: string; message?: string } };
    };
    const binding = () => JSON.parse(readFileSync(ownerFile, 'utf8')) as { sandboxId: string; linkId?: string };
    const archives = () => { try { return readdirSync(join(dirname(ownerFile), ARCHIVE_DIR)); } catch { return []; } };
    const audits = async () => (await store.forOwner!(name).list('audit', { limit: 50 })).items.map((entry) => entry.action);
    const failNext = (count: number) => { failures = count; };
    return { name, call, shell, failNext, binding, archives, audits, computers };
  }

  it('(a) a container removed behind computerd\'s back: shell and screenshot succeed on a new container, nothing lost', async () => {
    const o = await owner({ waitMs: 240_000 });
    const profile = `/juno-private/agents/${agentUser(AGENT)}/chromium`;
    expect((await o.call('/v1/screens/self/ensure')).status).toBe(200);
    const wrote = await o.shell(`echo workspace-ok > /workspace/heal.txt && mkdir -p ${profile} && echo login-ok > ${profile}/marker && echo done`);
    expect(wrote.body.stdout?.trim()).toBe('done');
    const old = o.binding();
    quiet('rm', '-f', old.sandboxId);

    const again = await o.shell('cat /workspace/heal.txt; cat ' + profile + '/marker');
    expect(again.response.status).toBe(200);
    expect(again.body.stdout).toBe('workspace-ok\nlogin-ok\n');
    expect(again.response.headers.get(COMPUTER_RECREATED_HEADER)).not.toBeNull();
    const shot = await o.call('/v1/screens/self/screenshot');
    expect(shot.status).toBe(200);
    expect(shot.headers.get(COMPUTER_RECREATED_HEADER)).toBeNull();

    const fresh = o.binding();
    expect(fresh.sandboxId).not.toBe(old.sandboxId);
    expect(docker('inspect', '--format', '{{.State.Running}}', fresh.sandboxId).trim()).toBe('true');
    expect(o.archives()).toHaveLength(1);
    expect(await o.audits()).toContain('computer.recreated');
  }, 600_000);

  it('(b) a binding without a link id for a container that does not exist is archived at startup; first use just works', async () => {
    const o = await owner({ waitMs: 240_000, seedBinding: { sandboxId: 'f'.repeat(64), template: 'old-image' } });
    const first = await o.shell('echo first-use');
    expect(first.response.status).toBe(200);
    expect(first.body.stdout?.trim()).toBe('first-use');
    expect(first.response.headers.get(COMPUTER_RECREATED_HEADER)).toBeNull();
    expect(o.binding().sandboxId).not.toBe('f'.repeat(64));
    expect(o.binding().linkId).toBeDefined();
    expect(o.archives()).toHaveLength(1);
  }, 600_000);

  it('(c) creates keep failing: the caller hears "being restored", the recovery goes on with backoff and succeeds', async () => {
    const o = await owner({ waitMs: 1_500 });
    expect((await o.shell('echo up && echo kept > /workspace/c.txt')).response.status).toBe(200);
    const old = o.binding();
    o.failNext(4);
    quiet('rm', '-f', old.sandboxId);

    const waiting = await o.shell('cat /workspace/c.txt');
    expect(waiting.response.status).toBe(503);
    expect(waiting.body.code).toBe('computer_recovering');

    // The platform keeps going on its own; the agent just calls again.
    let last = waiting;
    for (let attempt = 0; attempt < 90 && last.response.status !== 200; attempt += 1) {
      await new Promise((done) => setTimeout(done, 1_000));
      last = await o.shell('cat /workspace/c.txt');
    }
    expect(last.response.status).toBe(200);
    expect(last.body.stdout).toBe('kept\n');
    expect(o.binding().sandboxId).not.toBe(old.sandboxId);
    const audits = await o.audits();
    expect(audits.filter((action) => action === 'computer.recreate_failed')).toHaveLength(4);
    expect(audits.filter((action) => action === 'computer.recreated')).toHaveLength(1);
    expect(o.archives()).toHaveLength(1);
  }, 900_000);
});
