/**
 * A real socket test of bridgeRfb: a fake x11vnc (RFB server that requires VNC auth and then
 * sends ServerInit) and a fake noVNC client (RFB client that expects "None"). Bridging them proves
 * the handoff the live run stalled on: the client's ClientInit must reach the server and the
 * server's ServerInit must reach the client, with no late or lost bytes on either side.
 *
 * The earlier version awaited a callback that only fired on close, so it could never finish while
 * the sockets stayed open. The bridge reports completion via onClose, so each test closes a loop
 * and awaits that signal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { serverListening, socketOpen } from './ws-helpers.js';
import { bridgeRfb } from '../transport/stream-bridge.js';
import { vncResponse } from '@agent-desktop/sandbox-adapters';

const VERSION = Buffer.from('RFB 003.008\n', 'ascii');
const CHALLENGE = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
const SERVER_INIT = Buffer.from('SERVER-INIT-PAYLOAD');
const SECURITY_NONE = Buffer.from([1]);
const CLIENT_INIT = Buffer.from([0]);
const PASSWORD = 'vnc-secret';
const noop = () => undefined;

const sockets: WebSocket[] = [];
const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** Pull a fixed number of bytes from a websocket, buffering across messages. */
function reader(socket: WebSocket): (count: number) => Promise<Buffer> {
  const queue: Buffer[] = [];
  const waiters: Array<() => void> = [];
  const length = () => queue.reduce((sum, chunk) => sum + chunk.length, 0);
  socket.on('message', (data: Buffer) => {
    queue.push(Buffer.from(data));
    for (const wake of waiters.splice(0)) wake();
  });
  return async (count) => {
    while (length() < count) await new Promise<void>((resolve) => waiters.push(resolve));
    const all = Buffer.concat(queue);
    queue.length = 0;
    if (all.length > count) queue.push(all.subarray(count));
    return all.subarray(0, count);
  };
}

/** Resolve when the socket closes. */
function socketClosed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

function raceClose(socket: WebSocket, ms: number): Promise<boolean> {
  return Promise.race([
    socketClosed(socket).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

/** A fake x11vnc: offers VNC auth, verifies the response, reads ClientInit, then sends ServerInit. */
function fakeX11vnc(server: WebSocketServer): void {
  servers.push(server);
  server.on('connection', (socket) => {
    const read = reader(socket);
    void (async () => {
      socket.send(VERSION);
      await read(12);
      socket.send(Buffer.from([1, 2]));
      expect((await read(1))[0]).toBe(2);
      socket.send(CHALLENGE);
      expect((await read(16)).equals(vncResponse(PASSWORD, CHALLENGE))).toBe(true);
      socket.send(Buffer.from([0, 0, 0, 0]));
      expect((await read(1)).equals(CLIENT_INIT)).toBe(true);
      socket.send(SERVER_INIT);
    })().catch(() => undefined);
  });
}

/** An upstream that accepts the socket but never sends a byte, to force the bridge timeout. */
function silentUpstream(server: WebSocketServer): void {
  servers.push(server);
  server.on('connection', () => {
    // Hold the connection open; the upstream handshake never starts.
  });
}

/** An upstream that rejects the VNC password. */
function refusingUpstream(server: WebSocketServer): void {
  servers.push(server);
  server.on('connection', (socket) => {
    const read = reader(socket);
    void (async () => {
      socket.send(VERSION);
      await read(12);
      socket.send(Buffer.from([1, 2]));
      await read(1);
      socket.send(CHALLENGE);
      await read(16);
      socket.send(Buffer.from([0, 0, 0, 1]));
    })().catch(() => undefined);
  });
}

/** A completed-handshake upstream that then echoes every frame, standing in for x11vnc. */
function loopback(server: WebSocketServer): void {
  servers.push(server);
  server.on('connection', (socket) => {
    const read = reader(socket);
    void (async () => {
      socket.send(VERSION);
      await read(12);
      socket.send(Buffer.from([1, 2]));
      await read(1);
      socket.send(CHALLENGE);
      await read(16);
      socket.send(Buffer.from([0, 0, 0, 0]));
      await read(1);
      socket.send(SERVER_INIT);
      socket.on('message', (data: Buffer) => socket.send(Buffer.from(data)));
    })().catch(() => undefined);
  });
}

interface Bridge {
  port: number;
  onClose: Promise<void>;
}

/** Start a client-facing websocket server that bridges each connection to the given upstream. */
async function startBridge(upstreamPort: number, timeoutMs?: number): Promise<Bridge> {
  const clientServer = new WebSocketServer({ port: 0 });
  servers.push(clientServer);
  await serverListening(clientServer);
  let release: () => void = () => undefined;
  const onClose = new Promise<void>((resolve) => {
    release = resolve;
  });
  clientServer.on('connection', (client) => {
    const upstream = new WebSocket('ws://127.0.0.1:' + upstreamPort + '/websockify');
    sockets.push(client, upstream);
    void bridgeRfb(client, upstream, PASSWORD, noop, { screenId: 'scr-1', control: true }, release, timeoutMs);
  });
  return { port: portOf(clientServer), onClose };
}

async function startServer(handler: (server: WebSocketServer) => void): Promise<number> {
  const server = new WebSocketServer({ port: 0 });
  await serverListening(server);
  handler(server);
  return portOf(server);
}

function portOf(server: WebSocketServer): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/**
 * Drive the client side as noVNC does, up to and including ClientInit. When pipeline is set, the
 * security choice and ClientInit are sent in one frame, before reading SecurityResult, to cover a
 * client that does not wait.
 */
async function fakeNoVnc(port: number, pipeline = false): Promise<WebSocket> {
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/');
  sockets.push(socket);
  const read = reader(socket);
  await socketOpen(socket);
  expect((await read(12)).equals(VERSION)).toBe(true);
  socket.send(VERSION);
  expect((await read(2)).equals(Buffer.from([1, 1]))).toBe(true); // count=1, type=None
  if (pipeline) {
    socket.send(Buffer.concat([SECURITY_NONE, CLIENT_INIT])); // choice + ClientInit, one frame
  } else {
    socket.send(SECURITY_NONE);
  }
  expect((await read(4)).readUInt32BE(0)).toBe(0); // SecurityResult OK
  if (!pipeline) socket.send(CLIENT_INIT);
  return socket;
}

describe('bridgeRfb', () => {
  it('forwards ClientInit upstream and ServerInit downstream, then closes cleanly', async () => {
    const upstreamPort = await startServer(loopback);
    const bridge = await startBridge(upstreamPort);

    const client = await fakeNoVnc(bridge.port);
    const read = reader(client);
    expect((await read(SERVER_INIT.length)).equals(SERVER_INIT)).toBe(true);

    // A frame after the handshake still passes through the raw pipe.
    client.send(Buffer.from('PING'));
    expect((await read(4)).toString()).toBe('PING');

    const closed = socketClosed(client);
    client.close(1000, 'done');
    await closed;
    await bridge.onClose;
  });

  it('forwards a ClientInit pipelined in the same frame as the security choice', async () => {
    const upstreamPort = await startServer(fakeX11vnc);
    const bridge = await startBridge(upstreamPort);

    const client = await fakeNoVnc(bridge.port, true);
    const read = reader(client);
    // fakeX11vnc reads ClientInit and only then sends ServerInit; receiving it proves no bytes
    // were lost when they arrived before the handshake finished.
    expect((await read(SERVER_INIT.length)).equals(SERVER_INIT)).toBe(true);

    const closed = socketClosed(client);
    client.close(1000, 'done');
    await closed;
    await bridge.onClose;
  });

  it('fails the stream when the upstream never finishes the handshake', async () => {
    const upstreamPort = await startServer(silentUpstream);
    const bridge = await startBridge(upstreamPort, 300);

    const client = await fakeNoVnc(bridge.port);
    // The bridge must close the client rather than hold it open indefinitely.
    expect(await raceClose(client, 3000)).toBe(true);
  });

  it('fails the stream when the upstream refuses VNC authentication', async () => {
    const upstreamPort = await startServer(refusingUpstream);
    const bridge = await startBridge(upstreamPort);

    const client = await fakeNoVnc(bridge.port);
    expect(await raceClose(client, 3000)).toBe(true);
  });
});
