/**
 * The RFB man-in-the-middle used by the VNC bridge: it runs the two handshakes (client side
 * "None", upstream VNC auth with the server-held password) and then pipes the raw frames.
 *
 * Over a narrow websocket interface so it is unit-testable without a real socket. A handshake is
 * bounded by a deadline so a dead or silent upstream fails the stream fast instead of holding the
 * client socket open forever (the live "init pending" symptom).
 */
import { WebSocket, type RawData } from 'ws';
import { RfbHandshake, type RfbChannel } from '@agent-desktop/sandbox-adapters';

export interface BridgeLog {
  (fields: Record<string, unknown>, message: string): void;
}

/** A stalled upstream handshake must fail the stream, not hang it. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Run the handshakes, then pipe bytes. Messages that arrive before the upstream is open are
 * buffered by the readers, so the client's handshake (sent immediately) is not lost.
 */
export async function bridgeRfb(
  client: WebSocket,
  upstream: WebSocket,
  password: string,
  log: BridgeLog,
  context: { screenId: string; control: boolean },
  onClose: () => void,
  timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): Promise<void> {
  let closed = false;
  const closeBoth = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    onClose();
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(code, reason);
    }
  };

  const server = new RfbHandshake(channelOf(client));
  const remote = new RfbHandshake(channelOf(upstream));

  try {
    await withinTimeout(runHandshake(server, remote, upstream, password), timeoutMs);
  } catch (error) {
    // Stop the handshake readers first, so a late frame cannot resurrect a failed stream.
    server.detach();
    remote.detach();
    log({ ...context, err: error }, 'screen handshake failed');
    closeBoth(1011, 'handshake failed');
    return;
  }

  // Bytes read after the last handshake step (for example a ClientInit sent together with the
  // security choice) live in the readers, not the sockets; forward them or they are lost.
  const serverRest = server.detach();
  const remoteRest = remote.detach();
  if (serverRest.leftover.length > 0 && upstream.readyState === WebSocket.OPEN) upstream.send(serverRest.leftover);
  if (remoteRest.leftover.length > 0 && client.readyState === WebSocket.OPEN) client.send(remoteRest.leftover);

  wire(client, upstream, closeBoth);
  wire(upstream, client, closeBoth);
  log(context, 'screen stream open');
}

async function runHandshake(
  server: RfbHandshake,
  remote: RfbHandshake,
  upstream: WebSocket,
  password: string,
): Promise<void> {
  await openUpstream(upstream);
  await Promise.all([server.acceptClient(), remote.authenticate(password)]);
}

/** Resolve once the upstream socket is usable; reject if it errors or closes first. */
function openUpstream(upstream: WebSocket): Promise<void> {
  if (upstream.readyState === WebSocket.OPEN) return Promise.resolve();
  if (upstream.readyState !== WebSocket.CONNECTING) return Promise.reject(new Error('upstream is not connected'));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      upstream.off('open', onOpen);
      upstream.off('error', onError);
      upstream.off('close', onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('upstream closed during handshake'));
    };
    upstream.on('open', onOpen);
    upstream.on('error', onError);
    upstream.on('close', onClose);
  });
}

/** Bound a handshake so a silent peer fails the stream instead of holding a socket forever. */
async function withinTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  // The race below reports the failure; this keeps a late rejection from surfacing as unhandled.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('RFB handshake timed out after ' + timeoutMs + 'ms')), timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function channelOf(socket: WebSocket): RfbChannel {
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    onMessage: (handler) => {
      const listener = (data: RawData, isBinary: boolean) => handler(toBuffer(data, isBinary));
      socket.on('message', listener);
      return () => socket.off('message', listener);
    },
    onClose: (handler) => {
      const onError = (error: Error) => handler(error);
      const onCloseEvent = () => handler();
      socket.on('error', onError);
      socket.on('close', onCloseEvent);
      return () => {
        socket.off('error', onError);
        socket.off('close', onCloseEvent);
      };
    },
  };
}

function toBuffer(data: RawData, isBinary: boolean): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data, isBinary ? 'binary' : 'utf8');
}

/** After the handshakes the RFB stream is symmetric; copy every frame both ways. */
function wire(from: WebSocket, to: WebSocket, onClose: (code: number, reason: string) => void): void {
  from.on('message', (data, isBinary) => {
    if (to.readyState !== WebSocket.OPEN) return;
    try {
      to.send(data, { binary: isBinary });
    } catch {
      onClose(1011, 'socket send failed');
    }
  });
  from.on('close', (code) => onClose(code === 1006 ? 1011 : code, 'closed'));
  from.on('error', () => onClose(1011, 'socket error'));
}

