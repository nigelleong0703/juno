/**
 * LIVE voxl on an E2B cloud sandbox (BACKEND 7.1b): the real isolation prepare and the real boot program with `stream: 'both'`, then
 * voxl's /healthz and /screenshot with the platform password, the agent's namespace unable to reach it, and CPU of voxl against
 * x11vnc idle and while Chromium scrolls a long page. A sandbox on E2B cloud can only dial a public computerd, which this test has
 * none of, so it drives the boot through E2B's own commands exactly like netns.e2b.live.test.ts; the link hop to the port is the same
 * `openStream` the noVNC bridge already uses. One sandbox, killed at the end. Skipped unless E2B_LIVE=1.
 *
 *   E2B_LIVE=1 E2B_TEMPLATE=desktop-debian-voxl; set -a; . ~/.config/juno/e2b-cloud.env; set +a; \
 *     pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/voxl.e2b.live.test.ts
 */
import { Sandbox } from '@e2b/desktop';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuntime, prepareScreen } from './isolation.js';
import { agentXauthority } from './isolation-user.js';
import { screenPorts } from './ports.js';
import { commandExitResult, type SandboxRuntime } from './runtime.js';
import { bootScreen } from './screen-boot.js';

const live = process.env['E2B_LIVE'] === '1' ? describe : describe.skip;
const AGENT = 'agent-voxl-live';
const DISPLAY = 1;
const CONTROL = 'ctl-secret';
const VIEW = 'view-secret';
const ports = screenPorts(DISPLAY);

function rootRuntime(sandbox: Sandbox): SandboxRuntime {
  return {
    async run(command, options = {}) {
      try {
        const result = await sandbox.commands.run(command, { user: 'root', timeoutMs: options.timeoutMs ?? 120_000, ...(options.envs === undefined ? {} : { envs: options.envs }) });
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

/** CPU of some processes over a window, as a percentage of one core (jiffies from /proc, so no sampling noise from `top`). */
const CPU_PY = `
import sys, time, os
secs = float(sys.argv[1]); pids = sys.argv[2:]
hz = os.sysconf('SC_CLK_TCK')
def jiffies(pid):
    try:
        f = open('/proc/%s/stat' % pid).read().rsplit(')', 1)[1].split()
        return int(f[11]) + int(f[12])
    except Exception:
        return 0
def total():
    f = [int(x) for x in open('/proc/stat').readline().split()[1:8]]
    return sum(f) - f[3] - f[4]
a = {p: jiffies(p) for p in pids}; t0 = total(); time.sleep(secs); t1 = total()
cores = os.cpu_count()
print(' '.join('%s=%.1f%%' % (p, (jiffies(p) - a[p]) / hz / secs * 100) for p in pids), 'whole_machine_busy=%.1f%% of %d cores' % ((t1 - t0) / hz / secs / cores * 100, cores))
`;

/** A voxl viewer: connects with the password, turns video on, acknowledges frames like the web client does, and counts bytes. */
const VOXL_CLIENT_PY = `
import sys, time, websocket
url, pw, secs = sys.argv[1], sys.argv[2], float(sys.argv[3])
ws = websocket.create_connection(url, header=['Authorization: Bearer ' + pw], timeout=5)
ws.send('v,1')
end = time.time() + secs; frames = 0; size = 0
while time.time() < end:
    try:
        m = ws.recv()
    except websocket.WebSocketTimeoutException:
        continue
    if isinstance(m, bytes):
        if m and m[0] == 1:
            frames += 1; size += len(m)
            ws.send('a,%d' % int.from_bytes(m[2:6], 'big'))
    elif '"ping"' in m:
        ws.send('po,' + m.split('"s":')[1].split('}')[0])
print('voxl_client frames=%d kbytes=%d' % (frames, size // 1024))
`;

/** A bare RFB viewer for an unauthenticated x11vnc: asks for incremental updates 30 times a second and reads everything it is sent. */
const RFB_CLIENT_PY = `
import sys, socket, struct, time, threading
port, secs = int(sys.argv[1]), float(sys.argv[2])
s = socket.create_connection(('127.0.0.1', port)); s.recv(12); s.send(b'RFB 003.008\\n')
n = s.recv(1)[0]; s.recv(n); s.send(bytes([1])); s.recv(4)
s.send(b'\\x01'); init = s.recv(24); nlen = struct.unpack('>I', init[20:24])[0]; s.recv(nlen)
w, h = struct.unpack('>HH', init[:4])
s.send(struct.pack('>BxH', 2, 4) + struct.pack('>iiii', 7, 16, 5, 0))
total = [0]; stop = time.time() + secs
def reader():
    while time.time() < stop:
        try: total[0] += len(s.recv(1 << 20))
        except Exception: return
threading.Thread(target=reader, daemon=True).start()
while time.time() < stop:
    s.send(struct.pack('>BBHHHH', 3, 1, 0, 0, w, h)); time.sleep(1 / 30)
print('rfb_client kbytes=%d' % (total[0] // 1024))
`;

const SCROLL_PAGE = `<!doctype html><meta charset=utf-8><title>scroll</title><body style="margin:0;font:16px sans-serif">${Array.from({ length: 300 }, (_, i) => `<div style="padding:24px;background:linear-gradient(90deg,hsl(${(i * 37) % 360},70%,60%),hsl(${(i * 37 + 90) % 360},70%,40%));color:#fff"><h2>Row ${i}</h2><p>${'The quick brown fox jumps over the lazy dog. '.repeat(6)}</p></div>`).join('')}</body>`;

live('voxl on an E2B cloud sandbox', () => {
  let sandbox: Sandbox;
  let root: SandboxRuntime;
  const sh = async (command: string, timeoutMs = 120_000) => {
    const result = await root.run(command, { timeoutMs });
    return result.stdout.trim() + (result.exitCode === 0 ? '' : `\n[exit ${result.exitCode}] ${result.stderr}`);
  };
  const xenv = () => `export DISPLAY=:${DISPLAY} XAUTHORITY=${agentXauthority(AGENT)}`;
  const report: string[] = [];

  beforeAll(async () => {
    sandbox = await Sandbox.create(process.env['E2B_TEMPLATE'] ?? 'desktop-debian-voxl', { timeoutMs: 25 * 60_000 });
    root = rootRuntime(sandbox);
    await prepareScreen(root, sandbox.sandboxId, AGENT, DISPLAY);
    await bootScreen(root, { agentId: AGENT, displayNo: DISPLAY, resolution: '1440x900', controlPassword: CONTROL, viewPassword: VIEW, stream: 'both' });
    await root.writeText('/tmp/cpu.py', CPU_PY);
    await root.writeText('/tmp/voxl_client.py', VOXL_CLIENT_PY);
    await root.writeText('/tmp/rfb_client.py', RFB_CLIENT_PY);
    await root.writeText('/tmp/scroll.html', SCROLL_PAGE);
  }, 600_000);

  afterAll(async () => {
    console.log('\n=== voxl live report ===\n' + report.join('\n'));
    if (sandbox) await Sandbox.kill(sandbox.sandboxId).catch(() => undefined);
  }, 60_000);

  it('serves /healthz without a password and /screenshot only with it, on both instances', async () => {
    expect(await sh(`voxl --version`)).toContain('0.3.3');
    for (const [port, password] of [[ports.voxl, CONTROL], [ports.readOnlyVoxl, VIEW]] as const) {
      expect(await sh(`curl -s -m 5 http://127.0.0.1:${port}/healthz`)).toBe('ok');
      expect(await sh(`curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/screenshot`)).toBe('401');
      expect(await sh(`curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' http://127.0.0.1:${port}/screenshot`)).toBe('401');
      const shot = await sh(`curl -s -m 20 -H 'Authorization: Bearer ${password}' -o /tmp/shot-${port}.png -w '%{http_code} %{content_type} %{size_download}' http://127.0.0.1:${port}/screenshot && head -c 8 /tmp/shot-${port}.png | od -An -tx1`);
      expect(shot).toMatch(/^200 image\/png \d+\n?\s*89 50 4e 47/);
      report.push(`screenshot :${port} -> ${shot.split('\n')[0]}`);
    }
    // Each instance only takes its own password.
    expect(await sh(`curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer ${VIEW}' http://127.0.0.1:${ports.voxl}/screenshot`)).toBe('401');
  }, 120_000);

  it('is reachable by root only: not by the agent from its own namespace', async () => {
    const agent = agentRuntime(root, sandbox.sandboxId, AGENT);
    for (const port of [ports.voxl, ports.readOnlyVoxl]) {
      const result = await agent.run(`curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/healthz`, { timeoutMs: 30_000 });
      expect(result.stdout.trim()).toBe('000');
    }
    // voxl itself binds loopback only. E2B's own port forwarder re-exposes loopback listeners on the sandbox address (169.254.x), the same
    // as for x11vnc and websockify, which is why every instance sits behind its password.
    const listeners = await sh(`ss -ltn | grep -E ':(${ports.voxl}|${ports.readOnlyVoxl}) ' | awk '{print $4}' | sort | tr '\\n' ' '`);
    report.push('listeners: ' + listeners);
    expect(listeners).toContain(`127.0.0.1:${ports.voxl}`);
    expect(listeners).not.toContain('0.0.0.0');
  }, 120_000);

  it('measures CPU: voxl against x11vnc, idle and while Chromium scrolls', async () => {
    // An unauthenticated x11vnc with the production flags, so a plain client can connect to it; the production one stays untouched.
    await sh(`${xenv()}; nohup x11vnc -display :${DISPLAY} -auth ${agentXauthority(AGENT)} -forever -shared -localhost -rfbport 5950 -nopw -quiet >/tmp/x11vnc-bench.log 2>&1 & echo $! > /tmp/x11vnc-bench.pid; sleep 1`);
    const pidOf = async (name: string) => (await sh(`cat /run/juno/screen-${DISPLAY}/${name}.pid`)).trim();
    const voxlPid = await pidOf('voxl');
    const vncPid = (await sh('cat /tmp/x11vnc-bench.pid')).trim();
    const xvfbPid = await pidOf('xvfb');
    const chromiumPid = (await sh(`cat /tmp/agent-screen-${DISPLAY}/chromium.pid`)).trim();
    const sample = async (label: string, seconds: number, clients: string[]) => {
      const background = clients.map((client) => `(${client}) > /tmp/client-$$.out 2>&1 &`).join('\n');
      const out = await sh(`${background}\nsleep 2; python3 /tmp/cpu.py ${seconds} ${voxlPid} ${vncPid} ${xvfbPid} ${chromiumPid}\nwait`, 200_000);
      report.push(`${label}: pids voxl=${voxlPid} x11vnc=${vncPid} xvfb=${xvfbPid} chromium=${chromiumPid}\n    ${out}`);
      return out;
    };
    const voxlClient = (secs: number) => `python3 /tmp/voxl_client.py ws://127.0.0.1:${ports.voxl}/ws ${CONTROL} ${secs + 4}`;
    const rfbClient = (secs: number) => `python3 /tmp/rfb_client.py 5950 ${secs + 4}`;

    await sample('idle, no viewer', 10, []);
    await sample('idle, voxl viewer', 10, [voxlClient(10)]);
    await sample('idle, x11vnc viewer', 10, [rfbClient(10)]);

    // Chromium on a long page, then wheel notches at ~30 Hz for the whole window.
    await sh(`${xenv()}; xdotool search --pid ${chromiumPid} | head -1 > /tmp/win; xdotool windowfocus $(cat /tmp/win); xdotool key ctrl+l; sleep 0.3; xdotool type --delay 5 'file:///tmp/scroll.html'; xdotool key Return; sleep 4`, 60_000);
    const scroller = (secs: number) => `${xenv()}; end=$(( $(date +%s) + ${secs + 4} )); i=0; while [ $(date +%s) -lt $end ]; do xdotool click --repeat 3 --delay 5 5; if [ $((i % 40)) = 39 ]; then xdotool key Home; fi; i=$((i+1)); sleep 0.03; done`;
    await sample('scrolling, voxl viewer', 15, [voxlClient(15), scroller(15)]);
    await sample('scrolling, x11vnc viewer', 15, [rfbClient(15), scroller(15)]);
    await sample('scrolling, no viewer (baseline: Chromium + Xvfb only)', 15, [scroller(15)]);
    report.push('machine: ' + (await sh('nproc; free -m | sed -n 2p')).replace(/\n/g, ' | '));
    report.push(await sh(`for f in /tmp/client-*.out; do cat $f; done`));
    expect(report.length).toBeGreaterThan(5);
  }, 600_000);
});
