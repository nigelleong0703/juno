/**
 * LIVE Spaces (BACKEND 5.12) against a real throwaway container of the local desktop image: the real local provider, the
 * real Bun install script and gateway, two agents with real Linux users, the real iptables owner rules. Skipped unless
 * LIVE_DOCKER=1 (needs Docker, the image `juno-desktop:local` and network for apt, GitHub and npm). It starts its own
 * container and removes it afterwards; it never touches another one.
 *
 * The local image predates Spaces, so the test brings what the next image build brings: it installs `unzip` (a line of
 * template_debian.py), copies the skill with its templates and the gateway to the paths prepare_assets.py uses, and runs
 * the SAME install-runtime.sh the image build runs (pinned Bun, template dependencies into /opt/juno/bun-cache).
 *
 *   LIVE_DOCKER=1 pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/spaces.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import { agentRuntime } from './isolation.js';
import { httpOverStream } from './link-http.js';
import { liveImage, startLiveLink, type LiveLink } from './live-link.js';
import { createLocalProvider } from './local.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;

const A = 'agent-spaces-a';
const B = 'agent-spaces-b';
const SPACE_A = 'spaceaaaa1234567890';
const SPACE_WS = 'spacews0123456789';
/** What computerd derives per computer; any 64 hex digits will do for the test. */
const KEY = 'ab12'.repeat(16);
const files = (path: string) => fileURLToPath(new URL('../../sandbox-image/files/' + path, import.meta.url));
const signal = () => AbortSignal.timeout(600_000);

live('Spaces on a real container', () => {
  let link: LiveLink;
  let provider: ReturnType<typeof createLocalProvider>;
  let binding: E2bBinding;

  const root = (command: string, timeoutMs = 120_000) =>
    provider.withRuntime(binding, signal(), (runtime) => runtime.run(command, { timeoutMs }), { user: 'root' });
  const asAgent = (agentId: string, command: string, timeoutMs = 120_000) =>
    provider.withRuntime(binding, signal(), (runtime) => agentRuntime(runtime, binding.sandboxId, agentId).run(command, { timeoutMs }), { user: 'root' });
  /** The gateway reached the way computerd reaches it: a byte stream through the computer link (no port is published). */
  const raw = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => httpOverStream(() => provider.gatewayStream(binding, signal()), path, init);
  const through = (space: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => raw(path, { ...init, headers: { 'x-juno-space': space, 'x-juno-gateway-key': KEY, ...init.headers } });

  beforeAll(async () => {
    link = await startLiveLink();
    provider = createLocalProvider({ ownerId: 'live-spaces-test', image: liveImage(), hub: link.hub, linkUrl: link.linkUrl });
    binding = await provider.create({ template: liveImage(), resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 }, signal());
    const id = binding.sandboxId;
    await root('mkdir -p /opt/juno/skills/spaces /opt/juno/spaces');
    execFileSync('docker', ['cp', files('skills/spaces') + '/.', id + ':/opt/juno/skills/spaces']);
    execFileSync('docker', ['cp', files('spaces') + '/.', id + ':/opt/juno/spaces']);
    await root('chown -R root:root /opt/juno && chmod -R a+rX /opt/juno && chmod 0755 /opt/juno/skills/spaces/spaces_tool.py /opt/juno/spaces/install-runtime.sh');
    const installed = await root('apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq unzip >/dev/null 2>&1 && sh /opt/juno/spaces/install-runtime.sh 2>&1 | tail -n 5', 600_000);
    expect(installed.stdout).toContain('1.3.14');
  }, 900_000);

  afterAll(() => {
    try {
      if (binding) execFileSync('docker', ['rm', '-f', binding.sandboxId], { stdio: 'ignore' });
    } finally {
      provider.dispose();
      link.close();
    }
  }, 60_000);

  it('the template builds as an agent from the offline cache and its app serves a page and a SQLite-backed API through the gateway', async () => {
    const made = await asAgent(A, '/opt/juno/skills/spaces/spaces_tool.py new notes --template app 2>&1', 300_000);
    expect(made.exitCode, made.stdout + made.stderr).toBe(0);
    expect(made.stdout).toContain('created /workspace/spaces/notes');
    const built = await asAgent(A, '/opt/juno/skills/spaces/spaces_tool.py build notes 2>&1', 300_000);
    expect(built.exitCode, built.stdout).toBe(0);

    // space_publish would allocate the port and write it; the tool then reads it.
    await asAgent(A, 'echo 7100 > /workspace/spaces/notes/.juno-port');
    expect((await asAgent(A, '/opt/juno/skills/spaces/spaces_tool.py port notes')).stdout.trim()).toBe('7100');
    await asAgent(A, 'cd /workspace/spaces/notes && setsid nohup /opt/juno/skills/spaces/spaces_tool.py start notes >/tmp/notes.log 2>&1 </dev/null &');
    let up = false;
    for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
      up = (await asAgent(A, 'curl -fs -o /dev/null http://127.0.0.1:7100/')).exitCode === 0;
      if (!up) await new Promise((done) => setTimeout(done, 500));
    }
    expect(up, (await asAgent(A, 'cat /tmp/notes.log')).stdout).toBe(true);

    // Root wires it: the listener is verified from the kernel's table, then route, firewall rule and gateway.
    await provider.registerSpace(binding, { agentId: A, spaceId: SPACE_A, port: 7100, gatewayKey: KEY }, signal());
    // Nothing is published: the only way to the gateway is the link.
    expect(execFileSync('docker', ['port', binding.sandboxId], { encoding: 'utf8' }).trim()).toBe('');
    const routes = await root('stat -c "%a %U" /etc/juno/spaces.json && cat /etc/juno/spaces.json');
    expect(routes.stdout).toContain('600 root');
    expect(routes.stdout).toContain(`"${SPACE_A}"`);

    const page = await through(SPACE_A, '/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
    const post = await through(SPACE_A, '/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'saved through the gateway' }) });
    expect(post.status).toBe(201);
    const list = (await (await through(SPACE_A, '/api/notes')).json()) as Array<{ text: string }>;
    expect(list.map((note) => note.text)).toEqual(['saved through the gateway']);
    // The database is a file in the app folder, written by the agent's user.
    expect((await root('stat -c "%U" /workspace/spaces/notes/data/app.db')).stdout.trim()).toMatch(/^juno-/);
  }, 900_000);

  it('only the owning agent (and root) can connect to the app port or the gateway; an unknown space is a 404', async () => {
    expect((await asAgent(A, 'curl -fs -o /dev/null --max-time 5 http://127.0.0.1:7100/')).exitCode).toBe(0);
    const b = await asAgent(B, 'curl -s -o /dev/null --max-time 5 http://127.0.0.1:7100/');
    expect(b.exitCode).toBe(7);
    // No agent may use the gateway from inside the computer; the platform comes in through the link (root).
    expect((await asAgent(A, 'curl -s -o /dev/null --max-time 5 http://127.0.0.1:7090/__health')).exitCode).toBe(7);
    expect((await root('curl -fs --max-time 5 http://127.0.0.1:7090/__health')).stdout).toBe('ok');

    // The link comes in as root, so the uid rules do not apply to it: the key is what keeps a known space id out (defense in depth).
    expect((await raw('/', { headers: { 'x-juno-space': SPACE_A } })).status).toBe(404);
    expect((await raw('/', { headers: { 'x-juno-space': SPACE_A, 'x-juno-gateway-key': 'ff'.repeat(32) } })).status).toBe(404);
    expect((await raw('/api/notes', { headers: { 'x-juno-space': SPACE_A, 'x-juno-gateway-key': '' } })).status).toBe(404);
    expect((await through(SPACE_A, '/')).status).toBe(200);
    const keyFile = await root('stat -c "%a %U" /etc/juno/gateway.key; cat /etc/juno/gateway.key');
    expect(keyFile.stdout).toContain('600 root');
    expect(keyFile.stdout).toContain(KEY);
    expect((await asAgent(A, 'cat /etc/juno/gateway.key')).exitCode).not.toBe(0);
    // The status read needs the key too, and names only apps that are up.
    expect((await raw('/__status')).status).toBe(404);
    expect(await (await raw('/__status', { headers: { 'x-juno-gateway-key': KEY } })).json()).toEqual({ listening: [SPACE_A] });
    // The app never sees the key.
    const seen = await asAgent(A, 'cd /workspace/spaces/notes && grep -c gateway-key server.ts || true');
    expect(seen.stdout.trim()).toBe('0');

    const unknown = await through('spacezzzz0000000000', '/');
    expect(unknown.status).toBe(404);
    expect((await through('NOT A SPACE', '/')).status).toBe(404);
    expect((await raw('/nothing')).status).toBe(404);
    expect((await raw('/__health')).status).toBe(200);
  }, 300_000);

  it('refuses to register what is not the agent\'s own loopback listener, and stops forwarding when someone else takes the port', async () => {
    await expect(provider.registerSpace(binding, { agentId: A, spaceId: 'spacenone012345678', port: 7103, gatewayKey: KEY }, signal())).rejects.toThrow(/nothing is listening on port 7103/);
    // Another agent (its user exists once it has done anything) asks to wire A's port.
    await asAgent(B, 'true');
    await expect(provider.registerSpace(binding, { agentId: B, spaceId: 'spacestolen0123456', port: 7100, gatewayKey: KEY }, signal())).rejects.toThrow(/not this agent's/);
    // An app open to every interface is refused.
    await asAgent(A, 'setsid nohup python3 -m http.server 7102 >/dev/null 2>&1 </dev/null &');
    await new Promise((done) => setTimeout(done, 1500));
    await expect(provider.registerSpace(binding, { agentId: A, spaceId: 'spaceopen012345678', port: 7102, gatewayKey: KEY }, signal())).rejects.toThrow(/127\.0\.0\.1 only/);
    await asAgent(A, 'pkill -f "http.server 7102" || true');

    // A's app exits; B binds the same port. The route still names A's uid, so the gateway must not hand B A's visitors.
    await asAgent(A, 'pkill -f "server.ts" || true');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await asAgent(A, 'curl -s -o /dev/null --max-time 2 http://127.0.0.1:7100/')).exitCode !== 0) break;
      await new Promise((done) => setTimeout(done, 300));
    }
    await asAgent(B, 'setsid nohup python3 -c "import http.server as h; h.HTTPServer((\'127.0.0.1\',7100), h.SimpleHTTPRequestHandler).serve_forever()" >/dev/null 2>&1 </dev/null &');
    await new Promise((done) => setTimeout(done, 2500));
    expect((await through(SPACE_A, '/')).status).toBe(404);
    await asAgent(B, 'pkill -f "serve_forever" || true');
  }, 300_000);

  it('forwards WebSockets through the gateway (Bun serving, root-run gateway)', async () => {
    await asAgent(A, `mkdir -p /workspace/spaces/ws && cat > /workspace/spaces/ws/echo.ts <<'EOS'
Bun.serve({ hostname: '127.0.0.1', port: 7105, fetch(req, server) { return server.upgrade(req) ? undefined : new Response('plain'); }, websocket: { message(ws, m) { ws.send('echo:' + m); } } });
EOS
setsid nohup bun /workspace/spaces/ws/echo.ts >/tmp/ws.log 2>&1 </dev/null &`);
    await new Promise((done) => setTimeout(done, 2000));
    await provider.registerSpace(binding, { agentId: A, spaceId: SPACE_WS, port: 7105, gatewayKey: KEY }, signal());
    await root(`cat > /tmp/ws-client.ts <<'EOS'
const ws = new WebSocket('ws://127.0.0.1:7090/socket', { headers: { 'x-juno-space': '${SPACE_WS}', 'x-juno-gateway-key': '${KEY}' } } as never);
ws.onopen = () => ws.send('ping');
ws.onmessage = (event) => { console.log(String(event.data)); process.exit(0); };
ws.onerror = () => { console.log('ws error'); process.exit(1); };
setTimeout(() => { console.log('ws timeout'); process.exit(2); }, 8000);
EOS`);
    const echoed = await root('bun /tmp/ws-client.ts', 30_000);
    expect(echoed.stdout.trim()).toBe('echo:ping');
  }, 120_000);
});
