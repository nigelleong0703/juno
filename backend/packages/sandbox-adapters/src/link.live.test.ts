/**
 * LIVE computer link (BACKEND §7.11) against real throwaway containers: a container with NO published port, whose
 * `juno-link` (compiled with `bun build --compile`, put in the image the way the image build does) dials computerd's link
 * endpoint (the real hub, in this process). Everything the platform does in the computer goes through that one connection:
 * commands as the agent user, files, a screen and its screenshot, a VNC stream, a Spaces app through the gateway. Then a cold
 * restart (the container stopped and started, and a new container on the same volumes): the link comes back, the browser
 * profile on durable storage keeps its login marker, and the published Space is started again by the platform.
 *
 * Skipped unless LIVE_DOCKER=1 (needs Docker, `juno-desktop:local`, Bun for the daemon binary, network for apt and GitHub).
 *
 *   BUN=/path/to/bun LIVE_DOCKER=1 pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/link.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createMemoryStore } from '@agent-desktop/db';
import type { E2bBinding, SpaceRecord } from '@agent-desktop/contracts';
import { spaceStartCommand } from 'juno-agent/modules/tools/tools/spacePublish';
import { agentUser } from './isolation.js';
import { streamConnector } from './link-hub.js';
import { httpOverStream } from './link-http.js';
import { liveSpacesImage, startLiveLink, type LiveLink } from './live-link.js';
import { createLocalProvider } from './local.js';
import { relaunchSpaces } from './space-relaunch.js';
import { createComputerStorage, volumeNames } from './storage.js';
import type { ScreenRequest } from './types.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const dockerQuiet = (...args: string[]) => {
  try {
    docker(...args);
  } catch {
    // already gone
  }
};
const signal = () => AbortSignal.timeout(300_000);
const A = 'agent-link-a';
const SPACE_ID = 'sp' + 'ab12cd34ef56'.repeat(2);
const KEY = 'cd34'.repeat(16);
const host = { template: '', resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 };
const screen = (displayNo: number): ScreenRequest => ({ agentId: A, displayNo, resolution: '1024x768', controlPassword: 'ctl-' + displayNo, viewPassword: 'view-' + displayNo });
const PROFILE = `/juno-private/agents/${agentUser(A)}/chromium`;

live('computer link: no published ports, everything over the link, cold-start recovery', () => {
  const owner = 'live-link-' + randomUUID().slice(0, 8);
  const store = createMemoryStore();
  const containers: string[] = [];
  let link: LiveLink;
  let provider: ReturnType<typeof createLocalProvider>;
  let binding: E2bBinding;

  const sh = async (command: string) => {
    const result = await provider.act(binding, A, 1, { kind: 'shell', input: { command, timeoutMs: 60_000 } }, signal());
    if (!result.shell) throw new Error('no shell result');
    return result.shell;
  };
  const root = (command: string) => provider.withRuntime(binding, signal(), (runtime) => runtime.run(command, { cwd: '/' }), { user: 'root' });
  const gateway = (path: string, headers: Record<string, string> = {}) =>
    httpOverStream(() => provider.gatewayStream(binding, signal()), path, { headers: { 'x-juno-space': SPACE_ID, 'x-juno-gateway-key': KEY, ...headers } });
  /** Poll until the Space answers through the gateway again (the platform restarts it after a cold start). */
  const waitForSpace = async (): Promise<string> => {
    let last = '';
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const reply = await gateway('/').catch((error: unknown) => ({ status: 0, text: () => String(error) }));
      last = `${reply.status} ${reply.text().slice(0, 80)}`;
      if (reply.status === 200) return reply.text();
      await new Promise((done) => setTimeout(done, 1_000));
    }
    throw new Error('the Space did not come back: ' + last);
  };

  beforeAll(async () => {
    link = await startLiveLink();
    const image = liveSpacesImage();
    provider = createLocalProvider({
      ownerId: owner,
      image,
      storage: createComputerStorage({ kind: 'local-volume' }),
      hub: link.hub,
      linkUrl: link.linkUrl,
      onStarted: (context) => relaunchSpaces({ store, gatewayKey: () => KEY }, context),
    });
    binding = await provider.create({ ...host, template: image }, signal());
    containers.push(binding.sandboxId);
  }, 900_000);

  afterAll(() => {
    for (const id of containers) dockerQuiet('rm', '-f', id);
    const names = volumeNames(owner);
    dockerQuiet('volume', 'rm', '-f', names.home, names.workspace, names.profiles);
    provider?.dispose();
    link?.close();
  }, 120_000);

  it('the container publishes nothing, yet its daemon is linked', () => {
    expect(docker('port', binding.sandboxId).trim()).toBe('');
    expect(JSON.parse(docker('inspect', '--format', '{{json .HostConfig.PortBindings}}', binding.sandboxId))).toEqual({});
    expect(binding.linkId).toBeDefined();
    expect(link.hub.get(binding.linkId ?? '')).toBeDefined();
  });

  it('commands as the agent user, files in and out, all over the link', async () => {
    expect((await sh('id -un')).stdout.trim()).toBe(agentUser(A));
    await provider.act(binding, A, 1, { kind: 'writeFile', input: { path: '/workspace/over-the-link.txt', content: 'written via the link\n' } }, signal());
    expect((await provider.act(binding, A, 1, { kind: 'readFile', path: '/workspace/over-the-link.txt' }, signal())).fileRead?.content).toBe('written via the link\n');
    expect((await sh('stat -c %U /workspace/over-the-link.txt')).stdout.trim()).toBe(agentUser(A));
    const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
    await link.hub.get(binding.linkId ?? '')?.writeFile('/tmp/blob.bin', bytes);
    expect((await root('sha256sum /tmp/blob.bin | cut -d" " -f1')).stdout.trim()).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('the link token and the daemon are out of the agents\' reach', async () => {
    const token = link.hub.tokenFor(binding.linkId ?? '');
    const spy = await sh(`cat /proc/1/environ 2>&1; ps -eo args 2>&1; ps eww -p 1 2>&1; env; ls /run/juno-link /etc/juno 2>&1; kill -0 1 2>&1; netstat -ltnp 2>&1 | grep -c juno-link`);
    expect(spy.stdout).not.toContain(token);
    expect(spy.stdout).not.toContain('JUNO_LINK');
    expect(spy.stdout).toContain('Permission denied');
    // The daemon is the container's first process, as root; it listens on nothing, so there is no local surface to talk to.
    const owner1 = (await root('ps -o user= -p 1; ps -o args= -p 1')).stdout;
    expect(owner1).toContain('root');
    expect(owner1).toContain('juno-link');
    expect((await root('netstat -ltn | grep -c "juno-link"; netstat -ltnp | grep juno-link | wc -l')).stdout.trim()).toMatch(/^0/);
    // What root's own commands inherit has no link variable either.
    expect((await root('env | grep -c JUNO_LINK; true')).stdout.trim()).toBe('0');
  });

  it('boots a screen, takes a screenshot and carries a VNC stream through the link; the browser debugging port is not reachable', async () => {
    await provider.ensureScreen(binding, screen(1), signal());
    expect((await provider.act(binding, A, 1, { kind: 'screenshot' }, signal())).screenshot?.width).toBeGreaterThan(0);
    const connection = link.hub.get(binding.linkId ?? '');
    // Raw VNC (x11vnc) first: the RFB banner.
    const raw = await connection!.openStream(5901);
    const banner = await new Promise<string>((resolve, reject) => {
      raw.once('data', (chunk: Buffer) => resolve(chunk.toString('latin1')));
      raw.once('error', reject);
      setTimeout(() => reject(new Error('no RFB banner')), 15_000);
    });
    expect(banner).toMatch(/^RFB 003\.00\d\n/);
    raw.destroy();
    // And the noVNC bridge the platform proxy uses, WebSocket on the stream.
    const stream = await provider.screenStream(binding, 1, false, signal());
    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket('ws://computer/websockify', ['binary'], { createConnection: streamConnector(() => Promise.resolve(stream)) as never });
      ws.once('message', (data: Buffer) => {
        ws.close();
        resolve(data.toString('latin1'));
      });
      ws.once('error', reject);
    });
    expect(first).toMatch(/^RFB 003\.00\d/);
    await expect(connection!.openStream(screen(1).displayNo + 9222)).rejects.toThrow(/not allowed/);
    await expect(connection!.openStream(22)).rejects.toThrow(/not allowed/);
  }, 300_000);

  it('a Spaces app is reachable through link -> gateway (with the key)', async () => {
    const made = await sh('/opt/juno/skills/spaces/spaces_tool.py new hello --template static 2>&1 && echo 7100 > /workspace/spaces/hello/.juno-port && echo "<h1>hello from the space</h1>" > /workspace/spaces/hello/public/index.html');
    expect(made.exitCode, made.stdout + made.stderr).toBe(0);
    await sh(`cd /workspace/spaces/hello && { setsid nohup ${spaceStartCommand('hello')} >/tmp/hello.log 2>&1 </dev/null & }`);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await sh('curl -fs -o /dev/null http://127.0.0.1:7100/')).exitCode === 0) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    await provider.registerSpace(binding, { agentId: A, spaceId: SPACE_ID, port: 7100, gatewayKey: KEY }, signal());
    const row: SpaceRecord = { id: SPACE_ID, agentId: A, slug: 'hello', title: 'Hello', port: 7100, status: 'published', artifactId: 'art-hello', computerId: binding.sandboxId, start: spaceStartCommand('hello'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await store.put('spaces', row, { agentId: A, status: 'published', parentId: 'art-hello' });
    expect((await gateway('/')).text()).toContain('hello from the space');
    expect((await gateway('/', { 'x-juno-gateway-key': 'ff'.repeat(32) })).status).toBe(404);
  }, 300_000);

  it('a browser login marker goes into the durable profile', async () => {
    const made = await sh(`mkdir -p ${PROFILE}/Default && echo login-marker-1 > ${PROFILE}/Default/login-marker && stat -c '%U %a' ${PROFILE}`);
    expect(made.stdout.trim()).toBe(`${agentUser(A)} 755`.replace('755', made.stdout.trim().split(' ')[1] ?? ''));
    // Chromium really runs on that profile, on the volume (not in the agent's home).
    const chromium = await root(`ps -eo args | grep -c "[u]ser-data-dir=${PROFILE}"; ls /home/${agentUser(A)}/.config/chromium/Default 2>&1; findmnt -n -o SOURCE,FSTYPE /juno-private | head -1`);
    expect(chromium.stdout).toMatch(/^[1-9]/);
    expect(chromium.stdout).toContain('No such file');
    // The directory above the profile is the agent's private place; other users cannot even list /juno-private/agents.
    expect((await root(`stat -c '%U:%G %a' /juno-private /juno-private/agents /juno-private/agents/${agentUser(A)}`)).stdout.trim().split('\n')).toEqual(['root:root 711', 'root:root 711', `${agentUser(A)}:${agentUser(A)} 700`]);
  });

  it('a stopped and started container is a cold start: the link returns, the profile survives, the Space is started again', async () => {
    const before = link.hub.get(binding.linkId ?? '')?.bootId;
    docker('stop', '-t', '5', binding.sandboxId);
    await provider.connect(binding, signal());
    const after = link.hub.get(binding.linkId ?? '')?.bootId;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect((await root(`cat ${PROFILE}/Default/login-marker`)).stdout.trim()).toBe('login-marker-1');
    expect(await waitForSpace()).toContain('hello from the space');
    await provider.ensureScreen(binding, screen(1), signal());
    expect((await provider.act(binding, A, 1, { kind: 'screenshot' }, signal())).screenshot?.width).toBeGreaterThan(0);
    expect((await sh(`cat ${PROFILE}/Default/login-marker`)).stdout.trim()).toBe('login-marker-1');
  }, 600_000);

  it('a destroyed container and a new one on the same storage: same profile, same files, the Space comes back', async () => {
    dockerQuiet('rm', '-f', binding.sandboxId);
    const old = binding.sandboxId;
    binding = await provider.create({ ...host, template: liveSpacesImage() }, signal());
    containers.push(binding.sandboxId);
    expect(binding.sandboxId).not.toBe(old);
    expect(docker('port', binding.sandboxId).trim()).toBe('');
    expect((await root(`cat ${PROFILE}/Default/login-marker /workspace/over-the-link.txt`)).stdout).toContain('login-marker-1');
    expect(await waitForSpace()).toContain('hello from the space');
    await provider.ensureScreen(binding, screen(1), signal());
    expect((await provider.act(binding, A, 1, { kind: 'screenshot' }, signal())).screenshot?.width).toBeGreaterThan(0);
    expect((await sh(`id -un; cat ${PROFILE}/Default/login-marker`)).stdout).toContain('login-marker-1');
  }, 900_000);
  it('an image rebuilt under a paused computer replaces it on resume: same volumes, cookies kept, Chromium restores the last session', async () => {
    const tag = 'juno-live-upgrade:' + randomUUID().slice(0, 8);
    const build = (label: string) => execFileSync('docker', ['build', '-t', tag, '-'], { input: `FROM ${liveSpacesImage()}\nLABEL upgrade=${label}\n`, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      build('1');
      const old = await provider.create({ ...host, template: tag }, signal());
      containers.push(old.sandboxId);
      await provider.ensureScreen(old, screen(1), signal());
      const prepared = await provider.withRuntime(old, signal(), (runtime) => runtime.run(`mkdir -p ${PROFILE}/Default/Sessions && echo cookie-marker > ${PROFILE}/Default/Cookies && chown -R ${agentUser(A)}: ${PROFILE}/Default`, { cwd: '/' }), { user: 'root' });
      expect(prepared.exitCode).toBe(0);
      docker('pause', old.sandboxId);
      build('2');
      await expect(provider.connect(old, signal())).rejects.toMatchObject({ reason: 'image_outdated' });
      expect(() => docker('inspect', old.sandboxId)).toThrow();
      binding = await provider.create({ ...host, template: tag }, signal());
      containers.push(binding.sandboxId);
      expect((await root(`cat ${PROFILE}/Default/Cookies`)).stdout.trim()).toBe('cookie-marker');
      await provider.ensureScreen(binding, screen(1), signal());
      expect((await root('ps -eo args | grep -c "[c]hromium.*--restore-last-session"')).stdout.trim()).toMatch(/^[1-9]/);
    } finally {
      dockerQuiet('image', 'rm', '-f', tag);
    }
  }, 900_000);
});
