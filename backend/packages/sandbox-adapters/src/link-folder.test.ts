/**
 * A Mac that joined as a computer (My Mac): its daemon limits itself to one folder, the user's Stop cancels the running command
 * and refuses new ones, and a withdrawn link id is refused by the hub even with a valid token.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { startLinkDaemon, type LinkDaemon } from 'juno-link/daemon';
import { FrameType, jsonFrame } from 'juno-link/protocol';
import { createLinkHub, type LinkHub } from './link-hub.js';
import { createLinkRuntime } from './link-runtime.js';

const LINK_ID = 'mac-test-0000000001';

describe('a Mac on the computer link', () => {
  let http: Server;
  let hub: LinkHub;
  let daemon: LinkDaemon;
  let base: string;
  let folder: string;
  let outside: string;
  let url = '';
  const withdrawn = new Set<string>();

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'juno-mac-test-')));
    folder = join(base, 'Juno');
    outside = join(base, 'Documents');
    mkdirSync(folder);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'private');
    symlinkSync(outside, join(folder, 'escape'));
    hub = createLinkHub({ secret: 's3cret', withdrawn: (id) => withdrawn.has(id) });
    http = createServer();
    new WebSocketServer({ server: http, path: '/v1/computer-link' }).on('connection', (socket) => hub.accept(socket));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(http.address() as { port: number }).port}/v1/computer-link`;
    daemon = startLinkDaemon({
      loadConfig: () => ({ url, id: LINK_ID, token: hub.tokenFor(LINK_ID) }),
      scratchDir: join(base, 'scratch'),
      roots: [folder],
      backoff: { minMs: 50, maxMs: 200 },
    });
    await hub.waitFor(LINK_ID, 10_000);
  });

  afterAll(() => {
    daemon.stop();
    hub.close();
    http.close();
    rmSync(base, { recursive: true, force: true });
  });

  const runtime = () => createLinkRuntime({ hub, linkId: LINK_ID, cwd: folder });

  it('names its folder and starts commands there', async () => {
    expect((await hub.get(LINK_ID)?.health())?.host?.roots).toEqual([folder]);
    expect((await runtime().run('pwd')).stdout.trim()).toBe(folder);
  });

  it('reads and writes inside the folder and refuses everything outside it, links and .. included', async () => {
    await runtime().writeText(join(folder, 'notes/a.txt'), 'hi');
    expect(readFileSync(join(folder, 'notes/a.txt'), 'utf8')).toBe('hi');
    expect(await runtime().readText(join(folder, 'notes/a.txt'))).toBe('hi');
    await expect(runtime().readText(join(outside, 'secret.txt'))).rejects.toThrow(/outside the folders/);
    await expect(runtime().readText(join(folder, 'escape/secret.txt'))).rejects.toThrow(/outside the folders/);
    await expect(runtime().readText(join(folder, '../Documents/secret.txt'))).rejects.toThrow(/outside the folders/);
    await expect(runtime().writeText(join(outside, 'new.txt'), 'x')).rejects.toThrow(/outside the folders/);
    await expect(runtime().writeText(join(folder, 'escape/new.txt'), 'x')).rejects.toThrow(/outside the folders/);
    await expect(runtime().run('pwd', { cwd: outside })).rejects.toThrow(/outside the folders/);
  });

  it('Stop cancels the running command, refuses new work until resumed, and reports activity', async () => {
    const seen: number[] = [];
    const watcher = startLinkDaemon({
      loadConfig: () => ({ url, id: 'mac-test-0000000002', token: hub.tokenFor('mac-test-0000000002') }),
      scratchDir: join(base, 'scratch2'),
      roots: [folder],
      onActivity: (activity) => seen.push(activity.running),
    });
    const other = createLinkRuntime({ hub, linkId: 'mac-test-0000000002', cwd: folder });
    await hub.waitFor('mac-test-0000000002', 10_000);
    const running = other.run('sleep 30');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(watcher.activity().running).toBe(1);
    watcher.pause();
    await expect(running).rejects.toThrow(/pressed Stop/);
    await expect(other.run('echo hi')).rejects.toThrow(/pressed Stop/);
    watcher.resume();
    expect((await other.run('echo hi')).stdout).toBe('hi\n');
    expect(seen).toContain(1);
    expect(watcher.activity().running).toBe(0);
    watcher.stop();
  }, 20_000);

  it('refuses a link id that was withdrawn even with its derived token', async () => {
    withdrawn.add('mac-test-0000000003');
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => ws.send(jsonFrame(FrameType.HELLO, 0, { version: 1, id: 'mac-test-0000000003', token: hub.tokenFor('mac-test-0000000003'), bootId: 'x' })));
      ws.on('close', (closeCode) => resolve(closeCode));
    });
    expect(code).toBe(4401);
  });
});
