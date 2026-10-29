/** The person's Stop over the computer link (real hub + real daemon): what Stop reports, Stop from another client, and a Stop made while the Mac was away. */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { startLinkDaemon, type LinkDaemon } from 'juno-link/daemon';
import type { ControlBody } from 'juno-link/protocol';
import { createLinkHub, type LinkHub } from './link-hub.js';

const waitUntil = async (condition: () => boolean, ms = 5_000) => {
  for (const start = Date.now(); !condition() && Date.now() - start < ms;) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(condition()).toBe(true);
};

describe('Stop over the computer link', () => {
  let http: Server;
  let hub: LinkHub;
  let dir: string;
  let url: string;
  const heard: Array<[string, ControlBody]> = [];
  const rows = new Map<string, 'agent' | 'stopped'>();
  const daemons: LinkDaemon[] = [];

  const start = (id: string) => {
    const daemon = startLinkDaemon({ scratchDir: join(dir, 'scratch'), roots: [dir], backoff: { minMs: 50, maxMs: 300 }, loadConfig: () => ({ url, id, token: hub.tokenFor(id) }) });
    daemons.push(daemon);
    return daemon;
  };

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'juno-link-control-')));
    hub = createLinkHub({ secret: 's3cret', onControl: (id, body) => { heard.push([id, body]); rows.set(id, body.holder); }, controlOf: (id) => rows.get(id) });
    http = createServer();
    new WebSocketServer({ server: http, path: '/v1/computer-link' }).on('connection', (socket) => hub.accept(socket));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(http.address() as { port: number }).port}/v1/computer-link`;
  });

  afterAll(() => {
    for (const daemon of daemons) daemon.stop();
    hub.close();
    http.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports what Stop cancelled (first line of each command) and the resume, which only the daemon can send', async () => {
    const id = 'link-ctl-0001';
    const daemon = start(id);
    await hub.waitFor(id, 10_000);
    const running = hub.get(id)?.exec({ command: 'sleep 30\necho never-reported', timeoutMs: 60_000 }).catch((error: unknown) => error);
    await waitUntil(() => daemon.activity().running === 1);
    daemon.pause();
    await waitUntil(() => heard.some(([link]) => link === id));
    expect(heard.find(([link]) => link === id)?.[1]).toEqual({ holder: 'stopped', cancelled: ['sleep 30'] });
    expect(await running).toMatchObject({ code: 'user_control', details: { surface: 'mac', holder: 'stopped' } });
    daemon.resume();
    await waitUntil(() => heard.some(([link, body]) => link === id && body.holder === 'agent'));
  });

  it('a Stop made on another client reaches the connected Mac, which cancels and reports', async () => {
    const id = 'link-ctl-0002';
    const daemon = start(id);
    await hub.waitFor(id, 10_000);
    expect(hub.sendStop(id)).toBe(true);
    await waitUntil(() => daemon.activity().stopped);
    await waitUntil(() => heard.some(([link, body]) => link === id && body.holder === 'stopped'));
    expect(hub.sendStop('link-ctl-offline')).toBe(false);
  });

  it('a Mac that connects after a Stop made elsewhere learns it; a resume made on the Mac while offline is not undone by the hub', async () => {
    const id = 'link-ctl-0003';
    rows.set(id, 'stopped');
    const daemon = start(id);
    await waitUntil(() => daemon.activity().stopped);
    // Resume on the Mac while connected, drop the link, and come back: the daemon announces its own change first.
    daemon.resume();
    await waitUntil(() => rows.get(id) === 'agent');
    daemon.stop();
    const back = start(id);
    await hub.waitFor(id, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(back.activity().stopped).toBe(false);
  });
});
