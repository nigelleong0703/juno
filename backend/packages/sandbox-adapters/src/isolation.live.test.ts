/**
 * LIVE per-agent isolation (BACKEND §7.9 verification list) against a real throwaway container of the local desktop
 * image: the real local provider, the real migration, two agents with real users, Xvfb with cookies, Chromium and
 * the iptables rules. Skipped unless LIVE_DOCKER=1 (it needs Docker, the image `juno-desktop:local` and network
 * access for apt). It starts its own container and removes it afterwards; it never touches another one.
 *
 *   LIVE_DOCKER=1 pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/isolation.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import { createSandboxHome } from './home.js';
import { agentUser, installPackages } from './isolation.js';
import { liveImage, startLiveLink, type LiveLink } from './live-link.js';
import { createLocalProvider } from './local.js';
import { screenPorts } from './ports.js';
import { agentSlug } from './screen-boot.js';
import type { ScreenRequest } from './types.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;

const A = 'agent-live-a';
const B = 'agent-live-b';
const DAY = '2026-10-14';
const signal = () => AbortSignal.timeout(240_000);

const request = (agentId: string, displayNo: number): ScreenRequest => ({
  agentId,
  displayNo,
  resolution: '1024x768',
  controlPassword: 'ctl-' + displayNo,
  viewPassword: 'view-' + displayNo,
});

live('per-agent isolation on a real container', () => {
  let link: LiveLink;
  let provider: ReturnType<typeof createLocalProvider>;
  let binding: E2bBinding;

  const sh = async (agentId: string, displayNo: number, command: string) => {
    const result = await provider.act(binding, agentId, displayNo, { kind: 'shell', input: { command, timeoutMs: 60_000 } }, signal());
    const out = result.shell;
    if (!out) throw new Error('no shell result');
    return out;
  };
  const root = <T>(fn: (run: (command: string) => Promise<string>) => Promise<T>) =>
    provider.withRuntime(binding, signal(), (runtime) => fn(async (command) => (await runtime.run(command)).stdout), { user: 'root' });

  beforeAll(async () => {
    link = await startLiveLink();
    provider = createLocalProvider({ ownerId: 'live-isolation-test', image: liveImage(), hub: link.hub, linkUrl: link.linkUrl });
    binding = await provider.create({ template: liveImage(), resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 }, signal());
    // The old world: B has a logged-in Chromium profile in the shared home, and /juno files exist as the home sync wrote them.
    await provider.withRuntime(binding, signal(), async (runtime) => {
      await runtime.run(`mkdir -p /home/agent/.config/chromium-${agentSlug(B)}/Default && echo b-login-marker > /home/agent/.config/chromium-${agentSlug(B)}/Default/login-marker`);
    });
    await root(async (run) => {
      await run('mkdir -p /juno/agents/' + B + ' /juno/agents/' + A + ' && echo "B soul" > /juno/agents/' + B + '/SOUL.md && echo "A soul" > /juno/agents/' + A + '/SOUL.md && echo shared > /juno/MEMORY.md');
    });
  }, 300_000);

  afterAll(() => {
    try {
      if (binding) execFileSync('docker', ['rm', '-f', binding.sandboxId], { stdio: 'ignore' });
    } finally {
      provider.dispose();
      link.close();
    }
  }, 60_000);

  it('migrates on first use, boots two agent screens and keeps B\'s browser login', async () => {
    await provider.ensureScreen(binding, request(A, 1), signal());
    await provider.ensureScreen(binding, request(B, 2), signal());
    const marker = await root((run) => run('ls /etc/juno/isolation-v1 && ls /etc/sudoers.d/agent 2>&1; true'));
    expect(marker).toContain('/etc/juno/isolation-v1');
    expect(marker).toContain('No such file');
    const moved = await sh(B, 2, `cat /home/${agentUser(B)}/.config/chromium/Default/login-marker`);
    expect(moved.stdout).toContain('b-login-marker');
    expect(await root((run) => run(`ls -d /home/agent/.config/chromium-${agentSlug(B)} 2>&1`))).toContain('No such file');
    expect((await sh(A, 1, 'id -un; id -Gn')).stdout).toContain(agentUser(A));
  }, 300_000);

  it('files: A cannot read B\'s identity or home, but reads its own and the shared layer', async () => {
    const own = await sh(A, 1, `cat /juno/agents/${A}/SOUL.md; cat /juno/MEMORY.md`);
    expect(own.stdout).toContain('A soul');
    expect(own.stdout).toContain('shared');
    const other = await sh(A, 1, `cat /juno/agents/${B}/SOUL.md`);
    expect(other.exitCode).not.toBe(0);
    expect(other.stderr).toContain('Permission denied');
    const home = await sh(A, 1, `ls /home/${agentUser(B)}`);
    expect(home.exitCode).not.toBe(0);
    expect(home.stderr).toContain('Permission denied');
    expect((await sh(A, 1, 'ls /juno/dreams /juno/self_improvement 2>&1')).stdout).toMatch(/Permission denied|No such file/);
  });

  it('files: daily log is A\'s own to append, MEMORY.md and others\' logs are not', async () => {
    await root(async () => undefined);
    await provider.withRuntime(binding, signal(), async (runtime) => {
      const home = createSandboxHome(runtime);
      await home.write(`memory/${DAY}/${A}.md`, '# A day\n');
      await home.write(`memory/${DAY}/${B}.md`, '# B day\n');
      await home.write(`agents/${B}/IDENTITY.md`, 'B identity');
    }, { user: 'root' });
    expect((await sh(A, 1, `echo "- note" >> /juno/memory/${DAY}/${A}.md && cat /juno/memory/${DAY}/${A}.md`)).stdout).toContain('- note');
    expect((await sh(B, 2, `cat /juno/memory/${DAY}/${A}.md`)).stdout).toContain('- note');
    expect((await sh(A, 1, 'echo hacked > /juno/MEMORY.md')).exitCode).not.toBe(0);
    expect((await sh(A, 1, `echo hacked >> /juno/memory/${DAY}/${B}.md`)).exitCode).not.toBe(0);
    expect((await sh(A, 1, `echo x > /juno/memory/${DAY}/evil.md`)).exitCode).not.toBe(0);
    expect((await sh(B, 2, `cat /juno/agents/${B}/IDENTITY.md`)).stdout).toContain('B identity');
    expect((await sh(A, 1, `cat /juno/agents/${B}/IDENTITY.md`)).exitCode).not.toBe(0);
    expect(await root((run) => run('cat /juno/MEMORY.md'))).toContain('shared');
  });

  it('files: the daily log the memory sync pre-creates belongs to its agent and only that agent appends', async () => {
    const next = '2026-10-15';
    await provider.withRuntime(binding, signal(), (runtime) => createSandboxHome(runtime).ensure(`memory/${next}/${A}.md`), { user: 'root' });
    expect((await root((run) => run(`stat -c '%U %a' /juno/memory/${next}/${A}.md`))).trim()).toBe(`${agentUser(A)} 640`);
    expect((await sh(A, 1, `echo "- ensured" >> /juno/memory/${next}/${A}.md && cat /juno/memory/${next}/${A}.md`)).stdout).toContain('- ensured');
    expect((await sh(B, 2, `echo hacked >> /juno/memory/${next}/${A}.md`)).exitCode).not.toBe(0);
  });

  it('workspace: a file one agent creates is readable and writable by the other', async () => {
    expect((await sh(A, 1, 'echo from-a > /workspace/shared.txt && mkdir -p /workspace/dir && echo inner > /workspace/dir/x.txt')).exitCode).toBe(0);
    const b = await sh(B, 2, 'cat /workspace/shared.txt && echo from-b >> /workspace/shared.txt && echo more >> /workspace/dir/x.txt && cat /workspace/shared.txt');
    expect(b.stderr).toBe('');
    expect(b.stdout).toContain('from-a');
    expect(b.stdout).toContain('from-b');
    expect((await sh(A, 1, 'cat /workspace/dir/x.txt')).stdout).toContain('more');
  });

  it('no sudo, no way up', async () => {
    expect((await sh(A, 1, 'sudo -n true')).exitCode).not.toBe(0);
    expect((await sh(A, 1, 'id -u')).stdout.trim()).not.toBe('0');
  });

  it('screens: A cannot reach B\'s browser (CDP) or VNC or display; A reaches its own CDP port from its shell (owner decision 2026-10-27), and root reaches both', async () => {
    const ports = screenPorts(2);
    const own = screenPorts(1);
    const probe = (port: number) => `curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/json/version; echo " exit=$?"`;
    expect((await sh(B, 2, probe(ports.cdp))).stdout).not.toContain('200');
    expect((await sh(A, 1, probe(ports.cdp))).stdout).not.toContain('200');
    expect((await sh(A, 1, probe(own.cdp))).stdout).toContain('200');
    expect(await root((run) => run(`curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:${own.cdp}/json/version`))).toBe('200');
    // VNC / noVNC ports are root-only for everyone, A's own included.
    for (const port of [own.vnc, own.web, ports.vnc, ports.web]) {
      const refused = await sh(A, 1, `python3 -c "import socket,sys; s=socket.socket(); s.settimeout(4); s.connect(('127.0.0.1',${port}))"; echo exit=$?`);
      expect(refused.stdout, `port ${port}`).not.toContain('exit=0');
    }
    expect((await root((run) => run(`curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:${ports.web}/vnc.html`)))).toBe('200');
    // A's own display works, B's refuses A's cookie and refuses a missing one.
    expect((await sh(A, 1, 'DISPLAY=:1 scrot -o /tmp/own.png && echo shot-ok')).stdout).toContain('shot-ok');
    const stolen = await sh(A, 1, 'DISPLAY=:2 scrot -o /tmp/other.png; echo exit=$?');
    expect(stolen.stdout).not.toContain('exit=0');
    const noCookie = await sh(A, 1, 'XAUTHORITY=/dev/null DISPLAY=:2 xdpyinfo >/dev/null; echo exit=$?');
    expect(noCookie.stdout).not.toContain('exit=0');
    expect((await sh(A, 1, `cat /home/${agentUser(B)}/.Xauthority`)).exitCode).not.toBe(0);
    // The platform still takes screenshots through its own wrapper.
    const shot = await provider.act(binding, B, 2, { kind: 'screenshot' }, signal());
    expect(shot.screenshot?.width).toBeGreaterThan(0);
  });

  it('browser tools and files tools work as the agent user', async () => {
    const tabs = await provider.act(binding, B, 2, { kind: 'browser', input: { action: 'tabs' } }, signal());
    expect(tabs.browser?.action).toBe('tabs');
    await provider.act(binding, A, 1, { kind: 'writeFile', input: { path: '/workspace/viafile.txt', content: 'written by tool\n' } }, signal());
    expect((await provider.act(binding, B, 2, { kind: 'readFile', path: '/workspace/viafile.txt' }, signal())).fileRead?.content).toBe('written by tool\n');
    expect((await sh(A, 1, 'stat -c %U /workspace/viafile.txt')).stdout.trim()).toBe(agentUser(A));
    const started = await provider.act(binding, A, 1, { kind: 'startProcess', input: { command: 'echo proc-out; sleep 1' } }, signal());
    const handle = started.process?.kind === 'started' ? started.process.snapshot.handle : '';
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const read = await provider.act(binding, A, 1, { kind: 'readProcess', input: { handle } }, signal());
    expect(read.process?.kind === 'read' ? read.process.output.output : '').toContain('proc-out');
  });

  it('installs system packages as root on request, usable by the agents', async () => {
    const output = await provider.withRuntime(binding, signal(), (runtime) => installPackages(runtime, ['hello']), { user: 'root' });
    expect(output.length).toBeGreaterThan(0);
    expect((await sh(A, 1, 'hello')).stdout).toContain('Hello, world');
    await expect(provider.withRuntime(binding, signal(), (runtime) => installPackages(runtime, ['bad name; rm -rf /']), { user: 'root' })).rejects.toThrow(/not a valid package name/);
  }, 300_000);

  it('forged pid files in A\'s own screen dir cannot make root kill B\'s browser, root\'s Xvfb or anything else', async () => {
    const bChromium = (await sh(B, 2, 'cat /tmp/agent-screen-2/chromium.pid')).stdout.trim();
    const bXvfb = (await root((run) => run('cat /run/juno/screen-2/xvfb.pid'))).trim();
    expect(bChromium).toMatch(/^\d+$/);
    expect(bXvfb).toMatch(/^\d+$/);
    // The root-run services' pid files are not in a place A can reach.
    expect((await sh(A, 1, 'ls /run/juno 2>&1; cat /run/juno/screen-2/xvfb.pid 2>&1')).stdout).toContain('Permission denied');
    // A points every pid file of its screen at B's Chromium, B's Xvfb and the container's init, then stops and re-boots its screen.
    const forge = ['chromium', 'chromiumwatch', 'dock', 'wm', 'xvfb', 'vnc', 'vncview', 'novnc', 'novncview'];
    const lines = forge.flatMap((name, index) => `echo ${[bChromium, bXvfb, '1'][index % 3]} > /tmp/agent-screen-1/${name}.pid`);
    expect((await sh(A, 1, lines.join('; '))).exitCode).toBe(0);
    await provider.stopScreen(binding, 1, signal());
    await provider.ensureScreen(binding, request(A, 1), signal());
    const alive = await root((run) => run(`kill -0 ${bChromium} && echo chromium-b-alive; kill -0 ${bXvfb} && echo xvfb-b-alive; kill -0 1 && echo init-alive`));
    // On a failure, say whether B's browser was replaced by its own watchdog (new pid, same owner) or is gone.
    const why = alive.includes('chromium-b-alive') && alive.includes('xvfb-b-alive') ? '' : await root((run) => run(
      `echo "B chromium.pid now: $(cat /tmp/agent-screen-2/chromium.pid 2>&1)"; ps -eo pid,ppid,user,etimes,args --sort=pid | grep -E 'chromium|Xvfb' | grep -v grep | cut -c1-160; tail -5 /tmp/agent-screen-2/chromiumwatch.log 2>/dev/null`));
    expect(alive, why).toContain('chromium-b-alive');
    expect(alive, why).toContain('xvfb-b-alive');
    expect(alive).toContain('init-alive');
    expect((await provider.act(binding, B, 2, { kind: 'screenshot' }, signal())).screenshot?.width).toBeGreaterThan(0);
    expect((await sh(A, 1, 'DISPLAY=:1 scrot -o /tmp/own3.png && echo shot-ok')).stdout).toContain('shot-ok');
  }, 300_000);

  it('a second migration is a no-op and screens stay up', async () => {
    const before = (await sh(A, 1, 'echo up')).stdout;
    await provider.withRuntime(binding, signal(), async () => undefined, { user: 'root' });
    expect(before).toContain('up');
    expect((await sh(A, 1, 'DISPLAY=:1 scrot -o /tmp/own2.png && echo shot-ok')).stdout).toContain('shot-ok');
  });
});
