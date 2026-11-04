/**
 * LIVE per-agent network namespaces (BACKEND §7.9, §7.9a) on a real E2B cloud sandbox, kernel and all. The E2B kernel has no
 * `xt_owner`; this is the check that namespaces, veth, NAT and nft do what the owner rules could not.
 *
 * It drives the real isolation code (`prepareForAgent`, `prepareScreen`, `bootScreen`, `agentRuntime`, the browser helper) through a
 * root runtime made of E2B's own `commands`/`files` calls, because a sandbox on E2B cloud can only dial a public computerd and
 * this test has none. The link daemon is not part of it: it is root in the root namespace and is not touched by any of this.
 * Costs E2B credit (one sandbox, killed at the end). Skipped unless E2B_LIVE=1.
 *
 *   E2B_LIVE=1 E2B_TEMPLATE=desktop-debian set -a; . ~/.config/juno/e2b-cloud.env; set +a; \
 *     pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/netns.e2b.live.test.ts
 */
import { Sandbox } from '@e2b/desktop';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuntime, agentUser, prepareForAgent, prepareScreen } from './isolation.js';
import { inAgentNetns } from './isolation-user.js';
import { screenPorts } from './ports.js';
import { commandExitResult, type SandboxRuntime } from './runtime.js';
import { createScreenFile } from './screen-file.js';
import { bootScreen } from './screen-boot.js';

const live = process.env['E2B_LIVE'] === '1' ? describe : describe.skip;
const A = 'agent-e2b-a';
const B = 'agent-e2b-b';

function rootRuntime(sandbox: Sandbox): SandboxRuntime {
  return {
    async run(command, options = {}) {
      try {
        const result = await sandbox.commands.run(command, {
          user: 'root',
          timeoutMs: options.timeoutMs ?? 120_000,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.envs === undefined ? {} : { envs: options.envs }),
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      } catch (error) {
        const exit = commandExitResult(error);
        if (exit) return exit;
        throw error;
      }
    },
    readText: (path) => sandbox.files.read(path, { user: 'root' }),
    readBytes: async (path) => new Uint8Array(await sandbox.files.read(path, { format: 'bytes', user: 'root' })),
    writeText: async (path, content) => {
      await sandbox.files.write(path, content, { user: 'root' });
    },
    writeBytes: async (path, content) => {
      await sandbox.files.write(path, content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer, { user: 'root' });
    },
  };
}

live('network namespaces on an E2B cloud sandbox', () => {
  let sandbox: Sandbox;
  let root: SandboxRuntime;
  const request = (agentId: string, displayNo: number) => ({ agentId, displayNo, resolution: '1024x768', controlPassword: 'ctl' + displayNo, viewPassword: 'view' + displayNo });
  const as = (agentId: string) => agentRuntime(root, sandbox.sandboxId, agentId);
  const curl = async (agentId: string, url: string) => {
    const result = await as(agentId).run(`curl -s -m 6 -o /dev/null -w '%{http_code}' ${url}`, { timeoutMs: 30_000 });
    return { code: result.exitCode, status: result.stdout.trim() };
  };

  beforeAll(async () => {
    sandbox = await Sandbox.create(process.env['E2B_TEMPLATE'] ?? 'desktop-debian', { timeoutMs: 25 * 60_000 });
    root = rootRuntime(sandbox);
    for (const [agent, display] of [[A, 1], [B, 2]] as const) {
      await prepareScreen(root, sandbox.sandboxId, agent, display);
      await bootScreen(root, request(agent, display));
    }
  }, 600_000);

  afterAll(async () => {
    if (sandbox) await Sandbox.kill(sandbox.sandboxId).catch(() => undefined);
  }, 60_000);

  it('gives each agent a namespace; the agent reaches the internet, never the metadata service, private ranges or root\'s services', async () => {
    expect((await as(A).run('id -un; ip -4 -o addr show dev eth0')).stdout).toContain(agentUser(A));
    expect(await curl(A, 'https://example.com')).toEqual({ code: 0, status: '200' });
    // Firecracker's metadata service answers a normal user even with 169.254/16 in denyOut; the namespace's forward rule stops it.
    expect((await curl(A, 'http://169.254.169.254/latest/api/token')).code).toBe(7);
    expect((await curl(A, 'http://10.0.0.1/')).code).toBe(7);
    expect((await curl(A, 'http://172.17.0.1/')).code).toBe(7);
    // envd listens on every interface of the root namespace; an agent cannot get to it by the sandbox's address or the veth gateway.
    const gateway = (await as(A).run("ip route show default | awk '{print $3}'")).stdout.trim();
    expect(gateway).toMatch(/^198\.19\./);
    expect((await curl(A, `http://${gateway}:49983/`)).status).toBe('000');
    expect((await curl(A, 'http://127.0.0.1:49983/')).status).toBe('000');
    // Root is untouched: the sandbox daemon keeps working (this very run goes through it) and root still reaches the metadata service.
    const rootMetadata = await root.run("curl -s -m 6 -o /dev/null -w '%{http_code}' -X PUT http://169.254.169.254/latest/api/token -H 'X-metadata-token-ttl-seconds: 10'");
    expect(rootMetadata.stdout.trim()).toBe('200');
  }, 180_000);

  it('each agent reaches its own browser\'s debugging port and not the other\'s', async () => {
    const own = screenPorts(1).cdp;
    const other = screenPorts(2).cdp;
    expect(await curl(A, `http://127.0.0.1:${own}/json/version`)).toEqual({ code: 0, status: '200' });
    expect((await curl(A, `http://127.0.0.1:${other}/json/version`)).status).not.toBe('200');
    expect(await curl(B, `http://127.0.0.1:${other}/json/version`)).toEqual({ code: 0, status: '200' });
    expect((await curl(B, `http://127.0.0.1:${own}/json/version`)).status).not.toBe('200');
    const bAddress = (await root.run(`${inAgentNetns(B)} ip -4 -o addr show dev eth0 | awk '{print $4}' | cut -d/ -f1`)).stdout.trim();
    expect((await curl(A, `http://${bAddress}:${other}/json/version`)).status).not.toBe('200');
    // Root has no debugging port on its own loopback.
    expect((await root.run(`curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${own}/json/version`)).stdout.trim()).toBe('000');
  }, 120_000);

  it('the platform\'s browser tool and screenshots work on both screens', async () => {
    const files = createScreenFile();
    for (const [agent, display] of [[A, 1], [B, 2]] as const) {
      const snapshot = await files.browser(root, agent, display, { action: 'snapshot' });
      expect(snapshot.action).toBe('snapshot');
      const shot = await files.screenshot(as(agent), display);
      expect(shot.width).toBeGreaterThan(0);
    }
  }, 120_000);

  it('a namespace lost is made again before the next agent command', async () => {
    await root.run(`ip netns delete ${agentUser(B)}`);
    await prepareForAgent(root, sandbox.sandboxId, B);
    expect(await curl(B, 'https://example.com')).toEqual({ code: 0, status: '200' });
  }, 120_000);
});
