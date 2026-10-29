/**
 * computerd's VNC websocket bridge: verifies the signed ticket, re-checks the screen's CURRENT
 * controller, then hands off to \`stream-bridge.ts\` for the RFB handshake and byte copy.
 *
 * The computer publishes no port (BACKEND §7.11): the stream reaches the display's websockify through the computer link, and
 * the proxy answers the VNC challenge with the server-held per-screen password. \`control\` on the ticket does not grant write access by
 * itself — a writable bridge also needs the stored control row to say \`user\` at the ticket's epoch, so a stale
 * ticket can never upgrade itself. A writable bridge then stays valid only while that row still says so: this process's gateway
 * closes it at once on a change, and every bridge re-reads the row every \`revalidateMs\` (2 s) and on its write frames, so a
 * hand-back made by ANOTHER computerd process also ends it (BACKEND 7.8b).
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ComputerProvider } from '@agent-desktop/sandbox-adapters';
import { streamConnector, verifyScreenTicket, type ScreenTicketClaims } from '@agent-desktop/sandbox-adapters';
import type { Lifecycle } from '../modules/computers/lifecycle.js';
import { bridgeRfb } from './stream-bridge.js';

interface ComputerScope {
  lifecycle: Lifecycle;
  provider: ComputerProvider;
}

export type VncProxyOptions = ({
  forOwner(owner: string): ComputerScope;
  lifecycle?: Lifecycle;
  provider?: ComputerProvider;
} | {
  forOwner?: undefined;
  lifecycle: Lifecycle;
  provider: ComputerProvider;
}) & {
  secret: string;
  log?: (fields: Record<string, unknown>, message: string) => void;
  /**
   * While the user holds control of a screen, renew that sandbox this often so the idle policy
   * cannot pause a session they are actively driving. A read-only watcher never renews. 0 disables
   * it (tests).
   */
  keepAliveMs?: number;
  /** How often a writable bridge re-reads its control row (default 2 s; the contract is "closes within 2 s of a hand-back"). */
  revalidateMs?: number;
};

export interface VncProxy {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

interface ActiveStream {
  /** Renew the owning sandbox's idle timer; called by the stream heartbeat. */
  renew(): void;
  close(): void;
}

const REVALIDATE_MS = 2_000;
/** A write frame triggers a re-read at most this often (a drag sends many frames). */
const FRAME_RECHECK_MS = 250;

const PATH = /^\/v1\/screens\/([^/]+)\/vnc(?:\?|$)/;

export function createVncProxy(opts: VncProxyOptions): VncProxy {
  const wss = new WebSocketServer({ noServer: true });
  const log = opts.log ?? (() => undefined);
  const keepAliveMs = opts.keepAliveMs ?? 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  // Only an authorized WRITABLE stream counts as activity: `control` is already the AND of the
  // caller's request and the screen's live `controller === 'user'`, so a read-only watcher never
  // renews. One timer serves every writable stream, started with the first and stopped with the
  // last (including a take-over revocation, which closes the stream).
  const renewable = new Set<ActiveStream>();
  const startHeartbeat = () => {
    if (keepAliveMs <= 0 || heartbeat) return;
    heartbeat = setInterval(() => {
      for (const stream of renewable) stream.renew();
    }, keepAliveMs);
    heartbeat.unref?.();
  };
  const stopHeartbeatIfIdle = () => {
    if (!heartbeat || renewable.size > 0) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  const refuse = (socket: Duplex, status: number, message: string) => {
    socket.write(
      `HTTP/1.1 ${status === 403 ? '403 Forbidden' : status === 404 ? '404 Not Found' : '400 Bad Request'}\r\nconnection: close\r\n\r\n${message}`,
    );
    socket.destroy();
  };

  return {
    handleUpgrade(request, socket, head) {
      const match = PATH.exec(request.url ?? '');
      if (!match) return refuse(socket, 404, 'not a screen stream');
      const screenId = decodeURIComponent(match[1] ?? '');
      const token = new URL(request.url ?? '', 'http://computerd').searchParams.get('t');
      const claims = token ? verifyScreenTicket(token, opts.secret) : null;
      if (!claims || claims.screenId !== screenId) return refuse(socket, 403, 'invalid or expired ticket');
      void bridge(request, socket, head, screenId, claims);
    },
  };

  async function bridge(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    screenId: string,
    claims: ScreenTicketClaims,
  ): Promise<void> {
    let stream: Duplex;
    let password: string;
    let control: boolean;
    let epoch = 0;
    let renew = () => undefined;
    let scope: ComputerScope;
    try {
      scope = opts.forOwner ? opts.forOwner(claims.ownerId) : opts;
      const { lifecycle, provider } = scope;
      const screen = await lifecycle.findById(screenId);
      if (!screen) return refuse(socket, 404, 'unknown screen');
      if (screen.ownerId !== claims.ownerId || screen.agentId !== claims.agentId) {
        return refuse(socket, 403, 'ticket identity does not match screen');
      }
      // Re-ensure the display on THIS process before asking for its port. After a computerd restart
      // the provider's in-process screen set is empty, so a persisted 'live' row is not enough: the
      // stream would fail with no_screen. `requireScreen` re-binds the SAME sandbox and display (it
      // never creates a VM) and re-runs the idempotent boot only when something is actually missing.
      const { binding } = await lifecycle.requireScreen(screen.agentId, new AbortController().signal);
      // Write access needs the ticket AND the control row saying the person holds the screen at the ticket's epoch; otherwise watch.
      const held = await lifecycle.control.get({ kind: 'screen', screenId }, screen.agentId);
      epoch = held.epoch;
      control = claims.control && held.holder === 'user' && (claims.epoch === undefined || claims.epoch === held.epoch);
      const secrets = lifecycle.vncSecrets(screen);
      password = control ? secrets.controlPassword : secrets.viewPassword;
      renew = () => {
        void provider.connect(binding, new AbortController().signal).catch(() => undefined);
      };
      stream = await provider.screenStream(binding, screen.displayNo, control, new AbortController().signal);
    } catch (error) {
      log({ err: error, screenId }, 'screen stream setup failed');
      return refuse(socket, 404, 'screen is not available');
    }

    const protocols = parseProtocols(request.headers['sec-websocket-protocol']);
    // The computer publishes no port: the noVNC bridge (websockify) is reached as a byte stream through the computer link, and the WebSocket handshake rides on it.
    const upstream = new WebSocket('ws://computer/websockify', protocols, { createConnection: streamConnector(() => Promise.resolve(stream)) as never });

    wss.handleUpgrade(request, socket, head, (client) => {
      const guards: Array<() => void> = [];
      let stream: ActiveStream | null = null;
      const release = () => {
        if (stream) renewable.delete(stream);
        stream = null;
        for (const stop of guards.splice(0)) stop();
        stopHeartbeatIfIdle();
      };
      stream = {
        renew,
        close: () => {
          release();
          if (client.readyState === WebSocket.OPEN) client.close(1000, 'control revoked');
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
            upstream.close(1000, 'control revoked');
          }
        },
      };
      if (control) {
        renewable.add(stream);
        startHeartbeat();
        // A writable bridge is valid only while the control row still says the person holds the screen at this epoch.
        const { lifecycle } = scope;
        const surface = { kind: 'screen', screenId } as const;
        const closing = stream;
        const stillMine = (state: { holder: string; epoch: number }) => state.holder === 'user' && state.epoch === epoch;
        let checking = false;
        let lastCheck = Date.now();
        const recheck = () => {
          if (checking) return;
          checking = true;
          lastCheck = Date.now();
          lifecycle.control.get(surface).then((state) => { if (!stillMine(state)) closing.close(); }, () => undefined).finally(() => { checking = false; });
        };
        guards.push(lifecycle.control.subscribe((state) => { if (state.id === `screen:${screenId}` && !stillMine(state)) closing.close(); }));
        const timer = setInterval(recheck, opts.revalidateMs ?? REVALIDATE_MS);
        timer.unref();
        guards.push(() => clearInterval(timer));
        const onFrame = () => { if (Date.now() - lastCheck >= FRAME_RECHECK_MS) recheck(); };
        client.on('message', onFrame);
        guards.push(() => client.off('message', onFrame));
      }
      void bridgeRfb(client, upstream, password, log, { screenId, control }, release);
    });
  }
}

function parseProtocols(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const value = Array.isArray(header) ? header.join(',') : header;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}
