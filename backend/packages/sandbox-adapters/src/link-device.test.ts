/**
 * A device declares what it can do: a Mac must (its HELLO is refused without one), the declaration is stored on the live
 * link, replaced when the device declares again, and gone with the link. A sandbox daemon declares nothing and is unaffected.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { startLinkDaemon, type LinkDaemon } from 'juno-link/daemon';
import { CLOSE_BAD_DECLARATION, FrameType, jsonFrame, type DeviceAction, type DeviceDeclaration } from 'juno-link/protocol';
import { createLinkHub, type LinkHub } from './link-hub.js';

const MAC_ID = 'mac-device-000000001';
const SANDBOX_ID = 'sandbox-device-00001';
const declaration = (actions: DeviceAction[]): DeviceDeclaration => ({ deviceId: 'dev-1', name: "Robin's MacBook", osVersion: 'macOS 15.2', actions });

describe('a device declaring what it can do', () => {
  let http: Server;
  let hub: LinkHub;
  let base: string;
  let url = '';
  const daemons: LinkDaemon[] = [];
  const start = (id: string, device?: () => DeviceDeclaration): LinkDaemon => {
    const daemon = startLinkDaemon({
      loadConfig: () => ({ url, id, token: hub.tokenFor(id) }),
      scratchDir: join(base, 'scratch'),
      backoff: { minMs: 50, maxMs: 200 },
      ...(device === undefined ? {} : { device }),
    });
    daemons.push(daemon);
    return daemon;
  };
  /** A raw client: sends the given HELLO body and resolves with the close code the hub answers with. */
  const closeCodeFor = (hello: Record<string, unknown>) => new Promise<number>((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => ws.send(jsonFrame(FrameType.HELLO, 0, { version: 1, id: MAC_ID, token: hub.tokenFor(MAC_ID), bootId: 'x', ...hello })));
    ws.on('close', (code) => resolve(code));
  });

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'juno-device-test-')));
    hub = createLinkHub({ secret: 's3cret', requireDeclaration: (id) => id.startsWith('mac-') });
    http = createServer();
    new WebSocketServer({ server: http, path: '/v1/computer-link' }).on('connection', (socket) => hub.accept(socket));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(http.address() as { port: number }).port}/v1/computer-link`;
  });

  afterAll(() => {
    for (const daemon of daemons) daemon.stop();
    hub.close();
    http.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses a Mac whose HELLO has no declaration, and one whose declaration is invalid', async () => {
    expect(await closeCodeFor({})).toBe(CLOSE_BAD_DECLARATION);
    expect(await closeCodeFor({ device: { deviceId: 'dev-1', name: 'Mac', osVersion: 'macOS', actions: ['files', 'teleport'] } })).toBe(CLOSE_BAD_DECLARATION);
    expect(await closeCodeFor({ device: { deviceId: 'dev-1', name: '', osVersion: 'macOS', actions: [] } })).toBe(CLOSE_BAD_DECLARATION);
    expect(hub.get(MAC_ID)).toBeUndefined();
  });

  it('still answers a bad token with the plain unauthorized close, before looking at the declaration', async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => ws.send(jsonFrame(FrameType.HELLO, 0, { version: 1, id: MAC_ID, token: 'wrong-token', bootId: 'x' })));
      ws.on('close', (closeCode) => resolve(closeCode));
    });
    expect(code).toBe(4401);
  });

  it('stores the declaration from HELLO, replaces it when the device declares again, and drops it with the link', async () => {
    let current = declaration(['files', 'shell']);
    const daemon = start(MAC_ID, () => current);
    const connection = await hub.waitFor(MAC_ID, 10_000);
    expect(connection.device()).toEqual(declaration(['files', 'shell']));

    current = declaration(['files', 'shell', 'desktop', 'browser']);
    daemon.redeclare();
    for (let attempt = 0; attempt < 100 && connection.device()?.actions.length === 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connection.device()?.actions).toEqual(['files', 'shell', 'desktop', 'browser']);

    // A device that connects again declares afresh (the permission may have changed while it was away).
    current = declaration(['files', 'shell', 'browser']);
    daemon.stop();
    for (let attempt = 0; attempt < 100 && connection.open; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hub.get(MAC_ID)).toBeUndefined();
    const again = start(MAC_ID, () => current);
    expect((await hub.waitFor(MAC_ID, 10_000)).device()?.actions).toEqual(['files', 'shell', 'browser']);
    again.stop();
  }, 20_000);

  it('drops a link that re-declares something invalid', async () => {
    const connection = await (async () => {
      const ws = new WebSocket(url);
      await new Promise<void>((resolve) => ws.on('open', () => {
        ws.send(jsonFrame(FrameType.HELLO, 0, { version: 1, id: MAC_ID, token: hub.tokenFor(MAC_ID), bootId: 'y', device: declaration(['files']) }));
        resolve();
      }));
      return ws;
    })();
    const closed = new Promise<number>((resolve) => connection.on('close', (code) => resolve(code)));
    await hub.waitFor(MAC_ID, 10_000);
    connection.send(jsonFrame(FrameType.DECLARE, 0, { deviceId: 'dev-1', name: 'Mac', osVersion: 'macOS', actions: ['everything'] }));
    expect(await closed).toBe(CLOSE_BAD_DECLARATION);
  });

  it('lets a sandbox daemon connect without declaring anything', async () => {
    start(SANDBOX_ID);
    const connection = await hub.waitFor(SANDBOX_ID, 10_000);
    expect(connection.device()).toBeUndefined();
  });
});
