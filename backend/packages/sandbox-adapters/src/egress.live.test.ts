/**
 * LIVE egress guard (BACKEND §7.9a) in a real throwaway container made by the real local provider: nothing an agent runs can
 * reach a private, link-local or metadata address or a service on the root side of the computer, while the public internet, DNS,
 * its own loopback and its own namespace address work and
 * the computer link (root, dialling computerd on the host's private address) stays up. After a cold restart the rules are back
 * before the next agent command.
 *
 * Skipped unless LIVE_DOCKER=1 (needs Docker, `juno-desktop:local`, Bun for the daemon binary, internet).
 *
 *   BUN=/path/to/bun LIVE_DOCKER=1 pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/egress.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import { liveImage, startLiveLink, type LiveLink } from './live-link.js';
import { createLocalProvider } from './local.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;
const dockerQuiet = (...args: string[]) => {
  try {
    execFileSync('docker', args, { stdio: 'ignore' });
  } catch {
    // already gone
  }
};
const signal = () => AbortSignal.timeout(300_000);
const AGENT = 'agent-egress';
const host = { template: '', resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 };

live('egress guard: agents cannot reach private networks', () => {
  const owner = 'live-egress-' + randomUUID().slice(0, 8);
  let link: LiveLink;
  let provider: ReturnType<typeof createLocalProvider>;
  let binding: E2bBinding;
  /** A service on THIS machine, standing in for anything private the host or its network offers; the container sees it at host.docker.internal. */
  let hostService: Server;
  let hostPort = 0;

  /** The exit code of `curl` as the agent (7 = refused at once, 28 = timed out) and the HTTP status. */
  const curl = async (url: string) => {
    const result = await provider.act(binding, AGENT, 1, { kind: 'shell', input: { command: `curl -s -m 6 -o /dev/null -w '%{http_code}' ${url}`, timeoutMs: 30_000 } }, signal());
    return { code: result.shell?.exitCode, status: result.shell?.stdout.trim() };
  };
  const asRoot = (command: string) => provider.withRuntime(binding, signal(), (runtime) => runtime.run(command, { cwd: '/' }), { user: 'root' });
  const shell = async (command: string) => (await provider.act(binding, AGENT, 1, { kind: 'shell', input: { command, timeoutMs: 30_000 } }, signal())).shell;

  beforeAll(async () => {
    hostService = createServer((_request, response) => response.end('host secret')).listen(0, '0.0.0.0');
    await new Promise((done) => hostService.once('listening', done));
    hostPort = (hostService.address() as { port: number }).port;
    link = await startLiveLink();
    provider = createLocalProvider({ ownerId: owner, image: liveImage(), hub: link.hub, linkUrl: link.linkUrl });
    binding = await provider.create({ ...host, template: liveImage() }, signal());
  }, 900_000);

  afterAll(() => {
    if (binding) dockerQuiet('rm', '-f', binding.sandboxId);
    provider?.dispose();
    link?.close();
    hostService?.close();
  }, 120_000);

  it('refuses the metadata address, private ranges and the host, for the agent only', async () => {
    expect((await curl('http://169.254.169.254/latest/meta-data/')).code).toBe(7);
    expect((await curl('http://10.0.0.1/')).code).toBe(7);
    expect((await curl('http://172.20.0.1/')).code).toBe(7);
    // The control: the service on the host answers, so the refusals above are the guard, not a dead target.
    expect((await asRoot(`curl -s -m 6 http://host.docker.internal:${hostPort}/`)).stdout).toBe('host secret');
    expect((await curl(`http://host.docker.internal:${hostPort}/`)).code).toBe(7);
  }, 120_000);

  it('still reaches the public internet by name, its own loopback and its own namespace address', async () => {
    expect(await curl('https://example.com')).toEqual({ code: 0, status: '200' });
    await shell('nohup python3 -m http.server 8099 --bind 0.0.0.0 >/dev/null 2>&1 &');
    const own = await shell('for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 2 -o /dev/null http://127.0.0.1:8099/ && break; sleep 1; done; curl -s -m 4 -o /dev/null -w "%{http_code}" http://$(ip -4 -o addr show dev eth0 | awk \'{print $4}\' | cut -d/ -f1):8099/');
    expect(own?.stdout.trim()).toBe('200');
  }, 120_000);

  it('cannot reach a service of the root side of the computer, by the computer\'s address or the veth gateway; root can', async () => {
    // Stands in for the sandbox daemon, VNC and the Spaces gateway: root's services on every interface.
    await asRoot('setsid nohup python3 -m http.server 8098 --bind 0.0.0.0 >/dev/null 2>&1 </dev/null &');
    await new Promise((done) => setTimeout(done, 2500));
    expect((await asRoot('curl -s -m 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:8098/')).stdout).toBe('200');
    const gateway = (await shell('ip route show default | awk \'{print $3}\''))?.stdout.trim();
    expect(gateway).toMatch(/^198\.19\.\d+\.\d+$/);
    for (const address of [gateway, '$(hostname -i | cut -d" " -f1)']) {
      const probe = await shell(`curl -s -m 4 -o /dev/null -w "%{http_code}" http://${address}:8098/`);
      expect(probe?.stdout.trim(), `agent -> ${address}`).toBe('000');
    }
    expect((await asRoot('curl -s -m 4 -o /dev/null -w "%{http_code}" http://$(hostname -i | cut -d" " -f1):8098/')).stdout).toBe('200');
  }, 120_000);

  it('keeps the computer link up (root is not filtered)', async () => {
    expect(link.hub.get(binding.linkId ?? '')).toBeDefined();
    expect((await asRoot('echo alive')).stdout.trim()).toBe('alive');
  });

  it('a cold restart puts the rules back before the next agent command', async () => {
    dockerQuiet('stop', '-t', '2', binding.sandboxId);
    await provider.connect(binding, signal());
    expect((await curl('http://10.0.0.1/')).code).toBe(7);
    expect(await curl('https://example.com')).toEqual({ code: 0, status: '200' });
  }, 300_000);
});
