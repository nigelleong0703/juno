/**
 * LIVE regressions for the three computer faults of 2026-10-14, with real containers and the real link (the same wiring as
 * recovery.live.test.ts; "restart computerd" = drop the link hub and the provider and start new ones on the same port and files):
 *
 *  (1) fix 8599028, a paused computer while computerd restarts: the daemon's reconnect sleep was unref'd, so a failed attempt
 *      emptied the event loop, the daemon (PID 1) exited and recovery replaced a healthy computer, losing the open page.
 *      The next agent action must succeed in under 10 s on the same container with zero recoveries and the page still open.
 *  (2) same fix, hub gone for longer than the daemon's longest backoff (30 s): the daemon stays alive (no container restart,
 *      same boot id) and reconnects when a hub comes back.
 *  (3) fix c92daad, a replaced computer: the profile on durable storage still holds the old host's Chromium SingletonLock, so the
 *      browser did not start. After `docker rm -f` and a recovery on the same storage the snapshot works and the login cookie is there.
 *
 * Skipped unless LIVE_DOCKER=1 (needs Docker, `juno-desktop:local`, Bun for the daemon binary: BUN=/path/to/bun).
 *
 *   BUN=/path/to/bun LIVE_DOCKER=1 pnpm --filter @agent-desktop/computerd exec vitest run src/__tests__/restart.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { agentSchema } from '@agent-desktop/public-contracts';
import { agentUser, createComputerStorage, createLocalProvider, volumeNames } from '@agent-desktop/sandbox-adapters';
import { liveImage, startLiveLink, type LiveLink } from '@agent-desktop/sandbox-adapters/live-link';
import { ARCHIVE_DIR } from '../infrastructure/computer-state.js';
import { createOwnerComputers } from '../modules/computers/owner-computers.js';
import { createOwnerComputerApp } from '../transport/owner-routes.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const quiet = (...args: string[]) => { try { docker(...args); } catch { /* already gone */ } };
const hashOf = (owner: string) => createHash('sha256').update(owner).digest('hex');
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const AGENT = 'agent-restart';
const PORT = 7123;
const agentRow = (owner: string) => agentSchema.parse({
  id: AGENT, name: 'Restart', handle: 'restart', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work',
  pinned: false, lastActivity: '', unreadCount: 0, channels: [], computerId: 'c', skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
  model: { planner: { provider: 'x', model: 'x' }, computer: { provider: 'x', model: 'x' }, fast: { provider: 'x', model: 'x' } },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: owner,
});
/** A page that sets a persistent login cookie (/login) and shows the cookie the browser sends (/whoami). */
const SERVER = [
  'from http.server import BaseHTTPRequestHandler, HTTPServer',
  'class H(BaseHTTPRequestHandler):',
  '    def do_GET(self):',
  '        self.send_response(200)',
  "        self.send_header('Content-Type', 'text/html')",
  "        if self.path == '/login': self.send_header('Set-Cookie', 'juno_login=session-42; Max-Age=31536000; Path=/')",
  '        self.end_headers()',
  "        self.wfile.write(('<title>' + self.path + '</title><p>path ' + self.path + '</p><p>cookie [' + (self.headers.get('Cookie') or '') + ']</p>').encode())",
  '    def log_message(self, *a): pass',
  `HTTPServer(('127.0.0.1', ${PORT}), H).serve_forever()`,
].join('\n');

live('computer faults with real containers', () => {
  let dir: string;
  let image: string;
  const owners: string[] = [];
  const providers: Array<{ dispose(): void }> = [];
  const links: LiveLink[] = [];

  beforeAll(async () => {
    image = liveImage();
    dir = mkdtempSync(join(tmpdir(), 'restart-live-'));
  }, 900_000);

  afterAll(() => {
    for (const owner of owners) {
      for (const id of docker('ps', '-aq', '--filter', `label=dev.agent-desktop.owner=${hashOf(owner)}`).split('\n').filter(Boolean)) quiet('rm', '-f', id);
      const names = volumeNames(owner);
      quiet('volume', 'rm', '-f', names.home, names.workspace, names.profiles);
    }
    for (const provider of providers) provider.dispose();
    for (const each of links) each.close();
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  /** One owner's computerd. `restartComputerd()` replaces the hub, the provider and the owner state like a process restart does. */
  async function owner() {
    const name = 'restart-' + randomUUID().slice(0, 8);
    owners.push(name);
    const store = createMemoryStore();
    if (!store.forOwner) throw new Error('scoped store required');
    await store.forOwner(name).put('agents', agentRow(name));
    const bindingFile = join(dir, name, 'computerd-binding.json');
    const ownerFile = join(dirname(bindingFile), 'owners', hashOf(name), 'computerd-binding.json');
    const host = { template: image, resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 };
    let current = await startLiveLink();
    links.push(current);
    const assemble = () => {
      const computers = createOwnerComputers({
        store, legacyOwnerId: '', bindingFile, poolFile: join(dir, name, 'screen-pool.json'), host, secret: 's',
        providerForOwner: (ownerId) => {
          const provider = createLocalProvider({ ownerId, image, storage: createComputerStorage({ kind: 'local-volume' }), hub: current.hub, linkUrl: current.linkUrl });
          providers.push(provider);
          return provider;
        },
        recovery: { waitMs: 240_000, sleep: (ms) => sleep(Math.min(ms, 500)) },
      });
      return createOwnerComputerApp({ computers, token: 'service' });
    };
    let app = assemble();
    const call = (path: string, body: unknown = {}) => app.request(path, {
      method: 'POST',
      headers: { authorization: 'Bearer service', 'x-owner-id': name, 'x-agent-id': AGENT, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const shell = async (command: string) => {
      const response = await call('/v1/screens/self/shell/run', { command, timeoutMs: 60_000 });
      return { response, body: (await response.json()) as { stdout?: string; code?: string; message?: string } };
    };
    const browser = async (input: object) => {
      const response = await call('/v1/screens/self/browser/action', input);
      const body = (await response.json()) as { browser?: { url?: string; text?: string; snapshot?: unknown }; message?: string };
      return { response, body, text: JSON.stringify(body) };
    };
    const binding = () => JSON.parse(readFileSync(ownerFile, 'utf8')) as { sandboxId: string; linkId: string };
    const archives = () => { try { return readdirSync(join(dirname(ownerFile), ARCHIVE_DIR)); } catch { return []; } };
    const audits = async () => (await store.forOwner!(name).list('audit', { limit: 50 })).items.map((entry) => entry.action);
    const port = () => Number(new URL(current.linkUrl.replace('ws:', 'http:')).port);
    /** The platform restarts: the old hub and provider are gone for `downMs`, then new ones listen where the daemons dial. */
    const restartComputerd = async (downMs = 0) => {
      current.close();
      if (downMs > 0) await sleep(downMs);
      current = await startLiveLink('live-test-secret', port());
      links.push(current);
      app = assemble();
    };
    const hub = () => current.hub;
    const startServer = async () => {
      await shell(`cat > /workspace/page-server.py <<'PY'\n${SERVER}\nPY`);
      await shell(`{ setsid nohup python3 /workspace/page-server.py >/tmp/page-server.log 2>&1 </dev/null & }`);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await shell('curl -fs -o /dev/null http://127.0.0.1:' + PORT + '/; echo $?')).body.stdout?.trim() === '0') return;
        await sleep(500);
      }
      throw new Error('page server did not start');
    };
    return { name, call, shell, browser, binding, archives, audits, restartComputerd, hub, startServer };
  }

  it('(1) a paused computer while computerd restarts: the next action works fast on the same container, nothing recovered, the page still open', async () => {
    const o = await owner();
    expect((await o.call('/v1/screens/self/ensure')).status).toBe(200);
    await o.startServer();
    const opened = await o.browser({ action: 'navigate', url: `http://127.0.0.1:${PORT}/whoami` });
    expect(opened.response.status, opened.text).toBe(200);
    const before = o.binding();

    docker('pause', before.sandboxId);
    await o.restartComputerd();

    const started = Date.now();
    const snap = await o.browser({ action: 'snapshot' });
    const took = Date.now() - started;
    expect(snap.response.status, snap.text).toBe(200);
    expect(took).toBeLessThan(10_000);
    expect(snap.text).toContain(`127.0.0.1:${PORT}/whoami`);
    expect(o.binding().sandboxId).toBe(before.sandboxId);
    expect(docker('inspect', '--format', '{{.State.Paused}} {{.State.Running}} {{.RestartCount}}', before.sandboxId).trim()).toBe('false true 0');
    expect(await o.audits()).not.toContain('computer.recreated');
    expect(o.archives()).toHaveLength(0);
  }, 900_000);

  it('(2) the hub gone for longer than the longest backoff: the daemon stays alive and reconnects when a hub comes back', async () => {
    const o = await owner();
    expect((await o.shell('echo up')).response.status).toBe(200);
    const { sandboxId, linkId } = o.binding();
    const bootId = o.hub().get(linkId)?.bootId;
    expect(bootId).toBeDefined();
    const state = () => docker('inspect', '--format', '{{.State.Running}} {{.RestartCount}} {{.State.StartedAt}}', sandboxId).trim();
    const started = state();

    await o.restartComputerd(40_000);

    // The container was never stopped or restarted meanwhile, and PID 1 is still the one daemon of the first boot.
    expect(state()).toBe(started);
    expect(docker('exec', sandboxId, 'sh', '-c', 'tr "\\0" " " < /proc/1/cmdline').trim()).toContain('juno-link');
    let again;
    for (let attempt = 0; attempt < 60 && !again; attempt += 1) {
      again = o.hub().get(linkId);
      if (!again) await sleep(1_000);
    }
    expect(again?.bootId).toBe(bootId);
    expect(state()).toBe(started);
    const after = await o.shell('echo still-here');
    expect(after.body.stdout?.trim()).toBe('still-here');
    expect(o.binding().sandboxId).toBe(sandboxId);
    expect(await o.audits()).not.toContain('computer.recreated');
  }, 900_000);

  it('(3) a replaced computer on the same storage: the browser starts, the snapshot works and the login cookie is still there', async () => {
    const o = await owner();
    const profile = `/juno-private/agents/${agentUser(AGENT)}/chromium`;
    expect((await o.call('/v1/screens/self/ensure')).status).toBe(200);
    await o.startServer();
    const login = await o.browser({ action: 'navigate', url: `http://127.0.0.1:${PORT}/login` });
    expect(login.response.status, login.text).toBe(200);
    // Chromium writes cookies to disk in batches; wait until the login is in the durable profile before the computer dies.
    let stored = '';
    for (let attempt = 0; attempt < 90 && !stored.includes('found'); attempt += 1) {
      stored = (await o.shell(`grep -aq juno_login ${profile}/Default/Cookies 2>/dev/null && echo found; true`)).body.stdout ?? '';
      if (!stored.includes('found')) await sleep(1_000);
    }
    expect(stored).toContain('found');
    const old = o.binding();
    quiet('rm', '-f', old.sandboxId);

    // The next call recovers (a new computer, same volumes); the browser must come up on the profile the old host locked.
    expect((await o.call('/v1/screens/self/ensure')).status).toBe(200);
    expect(o.binding().sandboxId).not.toBe(old.sandboxId);
    expect(o.archives()).toHaveLength(1);
    await o.startServer();
    const snap = await o.browser({ action: 'snapshot' });
    expect(snap.response.status, snap.text).toBe(200);
    const page = await o.browser({ action: 'navigate', url: `http://127.0.0.1:${PORT}/whoami` });
    expect(page.response.status, page.text).toBe(200);
    const text = await o.browser({ action: 'get_text' });
    expect(text.text).toContain('juno_login=session-42');

    // The same fault at the moment of a launch: the profile names a computer that is not this one (what the old computer left)
    // and the browser is gone. Its relaunch must drop that lock instead of failing to start.
    await o.shell("pkill -u $(id -u) -f 'user-data-dir=[/]juno'; sleep 1; true");
    await o.shell(`ln -sf other-computer-4242 ${profile}/SingletonLock`);
    expect((await o.shell(`readlink ${profile}/SingletonLock`)).body.stdout?.trim()).toBe('other-computer-4242');
    const relaunched = await o.browser({ action: 'snapshot' });
    expect(relaunched.response.status, relaunched.text).toBe(200);
    const again = await o.browser({ action: 'navigate', url: `http://127.0.0.1:${PORT}/whoami` });
    expect(again.response.status, again.text).toBe(200);
    expect((await o.browser({ action: 'get_text' })).text).toContain('juno_login=session-42');
    expect((await o.shell(`readlink ${profile}/SingletonLock`)).body.stdout).not.toContain('other-computer');
  }, 900_000);
});
