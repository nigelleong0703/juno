/**
 * The computer link end to end without a container: the real hub on a loopback WebSocket server and the real daemon
 * (the code that `bun build --compile` ships), running on this machine. Commands and files act on this host's own temp
 * directory; streams go to a loopback echo server the daemon is told it may reach.
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { startLinkDaemon, type LinkDaemon } from 'juno-link/daemon';
import { FrameType, jsonFrame } from 'juno-link/protocol';
import { createLinkHub, streamConnector, type LinkHub } from './link-hub.js';
import { createLinkRuntime } from './link-runtime.js';

const LINK_ID = 'link-test-0001';
const SECRET = 's3cret';

describe('computer link (hub + daemon)', () => {
  let http: Server;
  let echo: TcpServer;
  let hub: LinkHub;
  let daemon: LinkDaemon;
  let dir: string;
  let echoPort = 0;
  let url = '';

  const dial = (id: string, token: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => ws.send(jsonFrame(FrameType.HELLO, 0, { version: 1, id, token, bootId: 'x' })));
      ws.on('close', (code) => resolve(code));
    });

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'juno-link-test-')));
    hub = createLinkHub({ secret: SECRET });
    http = createServer();
    const wss = new WebSocketServer({ server: http, path: '/v1/computer-link' });
    wss.on('connection', (socket) => hub.accept(socket));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(http.address() as { port: number }).port}/v1/computer-link`;
    echo = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    echoPort = (echo.address() as { port: number }).port;
    daemon = startLinkDaemon({
      loadConfig: () => ({ url, id: LINK_ID, token: hub.tokenFor(LINK_ID) }),
      scratchDir: join(dir, 'scratch'),
      allowPort: (port) => port === echoPort,
      backoff: { minMs: 50, maxMs: 1_500 },
    });
    await hub.waitFor(LINK_ID, 10_000);
  });

  afterAll(() => {
    daemon.stop();
    hub.close();
    http.close();
    echo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const runtime = () => createLinkRuntime({ hub, linkId: LINK_ID });

  it('runs a program: stdout, stderr, exit code, env, cwd; the program never appears in argv', async () => {
    const result = await runtime().run('echo out; echo err >&2; echo "$GREETING $(pwd)"; exit 3', { cwd: dir, envs: { GREETING: 'hi' } });
    expect(result).toEqual({ stdout: `out\nhi ${dir}\n`, stderr: 'err\n', exitCode: 3 });
    const argv = await runtime().run('ps -o args= -p $$', { cwd: dir });
    expect(argv.stdout).toMatch(/sh \S*exec-[0-9a-f-]+\.sh/);
    expect(argv.stdout).not.toContain('ps -o args= -p');
  });

  it('streams a lot of output and ends a timed-out command by killing its whole process group', async () => {
    const big = await runtime().run('head -c 3000000 /dev/zero | tr "\\0" a', { cwd: dir });
    expect(big.stdout.length).toBe(3_000_000);
    const marker = join(dir, 'late');
    await expect(runtime().run(`(sleep 3; touch ${marker}) & sleep 30`, { cwd: dir, timeoutMs: 400 })).rejects.toThrow(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(() => statSync(marker)).toThrow();
  }, 15_000);

  it('cancels a running command', async () => {
    const abort = new AbortController();
    const running = runtime().run('sleep 30', { cwd: dir, signal: abort.signal });
    setTimeout(() => abort.abort(), 200);
    await expect(running).rejects.toThrow(/cancelled/);
  });

  it('reads and writes files, binary included, creating directories', async () => {
    const link = hub.get(LINK_ID);
    const bytes = new Uint8Array(300_000).map((_, index) => index % 251);
    await link?.writeFile(join(dir, 'a/b/blob.bin'), bytes);
    expect(readFileSync(join(dir, 'a/b/blob.bin')).equals(Buffer.from(bytes))).toBe(true);
    expect(Buffer.from((await link?.readFile(join(dir, 'a/b/blob.bin'))) ?? new Uint8Array()).equals(Buffer.from(bytes))).toBe(true);
    await runtime().writeText(join(dir, 'text.txt'), 'héllo');
    expect(await runtime().readText(join(dir, 'text.txt'))).toBe('héllo');
    await runtime().writeText(join(dir, 'empty.txt'), '');
    expect(statSync(join(dir, 'empty.txt')).size).toBe(0);
    await expect(runtime().readText(join(dir, 'missing'))).rejects.toThrow(/no such file/);
  });

  it('answers health with a stable boot id', async () => {
    const health = await hub.get(LINK_ID)?.health();
    expect(health).toMatchObject({ ok: true, bootId: daemon.bootId });
  });

  it('opens byte streams only to whitelisted ports and carries data both ways', async () => {
    const link = hub.get(LINK_ID);
    const stream = await link!.openStream(echoPort);
    const payload = Buffer.alloc(900_000, 'xyz');
    const received: Buffer[] = [];
    stream.on('data', (piece: Buffer) => received.push(piece));
    stream.write(payload);
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (Buffer.concat(received).length >= payload.length) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    expect(Buffer.concat(received).equals(payload)).toBe(true);
    stream.destroy();
    await expect(link!.openStream(22)).rejects.toThrow(/port is not allowed/);
    await expect(link!.openStream(9222)).rejects.toThrow(/not allowed/);
  }, 20_000);

  it('serves an HTTP request through a stream', async () => {
    const web = createServer((req, res) => res.end('hello ' + req.url));
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
    const port = (web.address() as { port: number }).port;
    const restricted = startLinkDaemon({
      loadConfig: () => ({ url, id: 'link-test-0002', token: hub.tokenFor('link-test-0002') }),
      scratchDir: join(dir, 'scratch2'),
      allowPort: (p) => p === port,
      backoff: { minMs: 50, maxMs: 200 },
    });
    const link = await hub.waitFor('link-test-0002', 10_000);
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: 'x', path: '/ping', createConnection: streamConnector(() => link.openStream(port)) as never }, (res) => {
        let text = '';
        res.on('data', (piece) => (text += piece));
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end();
    });
    expect(body).toBe('hello /ping');
    restricted.stop();
    web.close();
  }, 20_000);

  it('refuses a wrong token or an unknown id, and a newer link replaces the older one', async () => {
    expect(await dial(LINK_ID, 'nope')).toBe(4401);
    expect(await dial('someone-else-1', hub.tokenFor(LINK_ID))).toBe(4401);
    expect(hub.linked()).toContain(LINK_ID);
    const first = hub.get(LINK_ID);
    const second = new WebSocket(url);
    await new Promise<void>((resolve) => second.on('open', () => resolve()));
    second.send(jsonFrame(FrameType.HELLO, 0, { version: 1, id: LINK_ID, token: hub.tokenFor(LINK_ID), bootId: 'newer' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(hub.get(LINK_ID)).not.toBe(first);
    expect(hub.get(LINK_ID)?.bootId).toBe('newer');
    expect(first?.open).toBe(false);
    second.close();
    // The real daemon was replaced; after its (long) back-off it dials back in and holds the link again.
    for (let attempt = 0; attempt < 100 && hub.get(LINK_ID)?.bootId !== daemon.bootId; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hub.get(LINK_ID)?.bootId).toBe(daemon.bootId);
  }, 20_000);

  it('fails calls fast when the daemon is gone and never trusts the file system for the token', async () => {
    writeFileSync(join(dir, 'token'), hub.tokenFor(LINK_ID));
    await expect(createLinkRuntime({ hub, linkId: 'never-linked-1', waitMs: 100 }).run('true')).rejects.toThrow(/not connected/);
  });
});
