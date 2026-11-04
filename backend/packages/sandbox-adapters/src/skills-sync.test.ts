/**
 * Platform skills reach computers that already exist (BACKEND §5.11b): the bundle's content version, the sync decision (equal: nothing
 * written; different: written, marker updated, old files gone) and the linked provider doing it at create and at the next look. The
 * computer is the real daemon running on this machine against temp directories, as in link.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { startLinkDaemon, type LinkDaemon } from 'juno-link/daemon';
import type { LifecycleDriver } from './driver.js';
import { createLinkHub, type LinkConnection, type LinkHub } from './link-hub.js';
import { createLinkRuntime } from './link-runtime.js';
import { createLinkedProvider } from './linked-provider.js';
import { readSkillsBundle } from './skills-bundle.js';
import { createSkillsRollout } from './skills-rollout.js';
import { syncPlatformSkills } from './skills-sync.js';

// The host has no nft/ip and no /run/juno; the link and the skills sync are what is under test.
vi.mock('./netns.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), applyEgressGuard: async () => undefined }));

const SECRET = 's3cret';
const sources: string[] = [];

function put(root: string, path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  chmodSync(join(root, path), mode);
}

function skillsSource(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'juno-skills-src-')));
  sources.push(dir);
  put(dir, 'pptx/SKILL.md', '---\nname: pptx\n---\nv1\n');
  put(dir, 'pptx/pptx_tool.py', '#!/usr/bin/env python3\nprint(1)\n', 0o755);
  put(dir, '_lib/requirements.txt', 'python-pptx==1.0\n');
  put(dir, 'spaces/templates/app/src/a-very-long-directory-name-to-need-a-tar-prefix/another-quite-long-directory-name-here/and-one-more-for-luck/App.tsx', 'x');
  return dir;
}

describe('skills bundle version', () => {
  it('is the same for the same files and changes with content, mode, a new file and a removed file', async () => {
    const dir = skillsSource();
    const base = (await readSkillsBundle(dir)).version;
    expect((await readSkillsBundle(dir)).version).toBe(base);
    put(dir, 'pptx/SKILL.md', '---\nname: pptx\n---\nv2\n');
    const edited = (await readSkillsBundle(dir)).version;
    expect(edited).not.toBe(base);
    chmodSync(join(dir, 'pptx/pptx_tool.py'), 0o644);
    const demoted = (await readSkillsBundle(dir)).version;
    expect(demoted).not.toBe(edited);
    put(dir, 'docx/SKILL.md', 'new');
    const added = (await readSkillsBundle(dir)).version;
    expect(added).not.toBe(demoted);
    rmSync(join(dir, 'docx'), { recursive: true });
    expect((await readSkillsBundle(dir)).version).toBe(demoted);
  });

  it('packs a tar that the system tar unpacks to the same files, with the script still executable (also for long paths)', async () => {
    const dir = skillsSource();
    const bundle = await readSkillsBundle(dir);
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'juno-skills-out-')));
    sources.push(out);
    writeFileSync(join(out, 'b.tar'), bundle.tar);
    execFileSync('tar', ['-xf', join(out, 'b.tar'), '-C', out]);
    for (const file of bundle.files) expect(readFileSync(join(out, file.path))).toEqual(file.content);
    expect(statSync(join(out, 'pptx/pptx_tool.py')).mode & 0o111).not.toBe(0);
    expect(statSync(join(out, 'pptx/SKILL.md')).mode & 0o111).toBe(0);
  });
});

describe('the sync against a computer (real hub + daemon)', () => {
  let http: Server;
  let hub: LinkHub;
  const daemons: LinkDaemon[] = [];
  let url = '';
  let base = '';

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'juno-skills-computer-')));
    sources.push(base);
    hub = createLinkHub({ secret: SECRET });
    http = createServer();
    const wss = new WebSocketServer({ server: http, path: '/v1/computer-link' });
    wss.on('connection', (socket) => hub.accept(socket));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(http.address() as { port: number }).port}/v1/computer-link`;
  });

  afterAll(() => {
    for (const daemon of daemons) daemon.stop();
    hub.close();
    http.close();
    for (const dir of sources) rmSync(dir, { recursive: true, force: true });
  });

  const dial = async (id: string) => {
    daemons.push(startLinkDaemon({ loadConfig: () => ({ url, id, token: hub.tokenFor(id) }), scratchDir: join(base, 'scratch-' + id), allowPort: () => false, backoff: { minMs: 50, maxMs: 1_500 } }));
    await hub.waitFor(id, 10_000);
    return createLinkRuntime({ hub, linkId: id });
  };

  it('writes the bundle when the computer has none or another version, and writes nothing when the version is equal', async () => {
    const src = skillsSource();
    const root = await dial('sync-decision');
    const dir = join(base, 'decision', 'skills');
    mkdirSync(dirname(dir), { recursive: true });

    const first = await syncPlatformSkills(root, await readSkillsBundle(src), { dir });
    expect(first.changed).toBe(true);
    expect(readFileSync(join(dir, 'pptx/SKILL.md'), 'utf8')).toContain('v1');
    expect(statSync(join(dir, 'pptx/pptx_tool.py')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dir, '.version'), 'utf8')).toBe((await readSkillsBundle(src)).version);

    // Equal version: not even the archive is written.
    const marker = statSync(join(dir, '.version')).mtimeMs;
    expect((await syncPlatformSkills(root, await readSkillsBundle(src), { dir })).changed).toBe(false);
    expect(statSync(join(dir, '.version')).mtimeMs).toBe(marker);
    expect(existsSync(dir + '.incoming.tar')).toBe(false);

    const firstVersion = readFileSync(join(dir, '.version'), 'utf8');
    // A changed file, a new file and a removed file: the directory is replaced, nothing stale stays, no temp left behind.
    put(src, 'pptx/SKILL.md', '---\nname: pptx\n---\nv2\n');
    put(src, 'docx/SKILL.md', 'docx');
    rmSync(join(src, 'spaces'), { recursive: true });
    put(src, '_lib/requirements.txt', 'python-pptx==2.0\n');
    const changed = await syncPlatformSkills(root, await readSkillsBundle(src), { dir });
    expect(changed).toEqual({ changed: true, previous: firstVersion, requirementsChanged: true });
    expect(readFileSync(join(dir, 'pptx/SKILL.md'), 'utf8')).toContain('v2');
    expect(existsSync(join(dir, 'docx/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'spaces'))).toBe(false);
    expect([dir + '.new', dir + '.old', dir + '.incoming.tar'].filter(existsSync)).toEqual([]);
  });

  it('a failed install leaves the computer\'s skills as they were', async () => {
    const src = skillsSource();
    const root = await dial('sync-failure');
    const dir = join(base, 'failure', 'skills');
    mkdirSync(dirname(dir), { recursive: true });
    await syncPlatformSkills(root, await readSkillsBundle(src), { dir });
    put(src, 'pptx/SKILL.md', 'broken');
    // The parent directory cannot be written: the sync fails before anything is replaced.
    chmodSync(dirname(dir), 0o555);
    try {
      await expect(syncPlatformSkills(root, await readSkillsBundle(src), { dir })).rejects.toThrow();
    } finally {
      chmodSync(dirname(dir), 0o755);
    }
    expect(readFileSync(join(dir, 'pptx/SKILL.md'), 'utf8')).toContain('v1');
    expect(existsSync(dir + '.new')).toBe(false);
  });

  it('the provider brings a new computer to the bundle before create returns, and an existing one at its next look', async () => {
    const src = skillsSource();
    const dir = join(base, 'provider', 'skills');
    const run = join(base, 'provider-run');
    mkdirSync(dirname(dir), { recursive: true });
    mkdirSync(run, { recursive: true });
    const archives: string[] = [];
    // The host has no /run/juno: the start marker goes to a temp directory; archive writes are counted.
    const redirect = (link: LinkConnection): LinkConnection =>
      new Proxy(link, {
        get(target, prop) {
          if (prop === 'writeFile') {
            return (path: string, ...rest: unknown[]) => {
              if (path.endsWith('.incoming.tar')) archives.push(path);
              return (target.writeFile as (...args: unknown[]) => Promise<void>)(path.replace('/run/juno/', run + '/'), ...rest);
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    const realWait = hub.waitFor.bind(hub);
    const providerHub = Object.create(hub, { waitFor: { value: async (...args: Parameters<LinkHub['waitFor']>) => redirect(await realWait(...args)) } }) as LinkHub;
    const driver: LifecycleDriver = {
      kind: 'fake',
      async create(spec) {
        daemons.push(startLinkDaemon({ loadConfig: () => ({ url, id: spec.link.id, token: spec.link.token }), scratchDir: join(base, 'scratch-provider'), allowPort: () => false, backoff: { minMs: 50, maxMs: 1_500 } }));
        return { sandboxId: 'sbx-skills', template: 'test' };
      },
      status: async () => 'running',
      start: async () => undefined,
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    const provider = createLinkedProvider({ driver, hub: providerHub, linkUrl: url, ownerId: 'owner', image: 'img', skills: createSkillsRollout({ hub: providerHub, bundle: () => readSkillsBundle(src), dir, log: () => undefined }) });
    const signal = new AbortController().signal;
    const binding = await provider.create({ template: 'img', resolution: '1280x800', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 1 }, signal);
    expect(readFileSync(join(dir, 'pptx/SKILL.md'), 'utf8')).toContain('v1');
    expect(archives).toHaveLength(1);

    // The server's skill changes; the existing computer is brought along when computerd next looks at it (a connect, a run, a screen).
    put(src, 'pptx/SKILL.md', '---\nname: pptx\n---\nv2\n');
    await provider.connect(binding, signal);
    await vi.waitFor(() => expect(readFileSync(join(dir, 'pptx/SKILL.md'), 'utf8')).toContain('v2'), { timeout: 10_000 });
    expect(readFileSync(join(dir, '.version'), 'utf8')).toBe((await readSkillsBundle(src)).version);
    expect(archives).toHaveLength(2);

    // Nothing changed since: looking again writes nothing.
    await provider.connect(binding, signal);
    await provider.connect(binding, signal);
    await new Promise((resolve) => setTimeout(resolve, 300)); // the background looks have finished reading the sources
    expect(archives).toHaveLength(2);
    provider.dispose();
  });

  it('a link that comes up again (computerd restarted after a deploy) is checked: synced when the version moved, current when not, one log line each', async () => {
    const src = skillsSource();
    const dir = join(base, 'redial', 'skills');
    mkdirSync(dirname(dir), { recursive: true });
    const lines: string[] = [];
    const up = createLinkHub({ secret: SECRET, onLinkUp: (linkId) => void rollout.ensure(linkId, 'computer-1', { verify: true }) });
    const rollout = createSkillsRollout({ hub: up, bundle: () => readSkillsBundle(src), dir, log: (_fields, message) => lines.push(message) });
    const server = createServer();
    new WebSocketServer({ server, path: '/v1/computer-link' }).on('connection', (socket) => up.accept(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const redialUrl = `ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/computer-link`;
    const id = 'redial-link-0001';
    daemons.push(startLinkDaemon({ loadConfig: () => ({ url: redialUrl, id, token: up.tokenFor(id) }), scratchDir: join(base, 'scratch-redial'), allowPort: () => false, backoff: { minMs: 50, maxMs: 300 } }));
    const first = (await readSkillsBundle(src)).version.slice(0, 12);
    await vi.waitFor(() => expect(lines).toEqual([`skills synced none→${first}`]), { timeout: 10_000 });

    // The deploy changes a skill; computerd restarts, the link redials (here: the hub cuts it), the new version arrives.
    put(src, 'pptx/SKILL.md', '---\nname: pptx\n---\nv2\n');
    const second = (await readSkillsBundle(src)).version.slice(0, 12);
    up.drop(id);
    await vi.waitFor(() => expect(lines).toEqual([`skills synced none→${first}`, `skills synced ${first}→${second}`]), { timeout: 10_000 });
    expect(readFileSync(join(dir, 'pptx/SKILL.md'), 'utf8')).toContain('v2');

    // A redial with nothing new in the bundle only says so.
    up.drop(id);
    up.drop(id);
    await vi.waitFor(() => expect(lines.at(-1)).toBe(`skills current ${second}`), { timeout: 10_000 });
    expect(await rollout.report()).toMatchObject({ bundle: expect.stringContaining(second), computers: [{ linkId: id, version: expect.stringContaining(second) }] });
    up.close();
    server.close();
  });
});
