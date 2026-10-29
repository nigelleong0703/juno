/**
 * agentd's public VNC websocket proxy. It verifies the signed ticket, then bridges the client to
 * computerd's internal bridge (which re-checks the ticket and the screen's controller). The VNC
 * servers themselves are loopback-only and passwordless, so the ticket is the only credential.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { verifyScreenTicket } from '@agent-desktop/sandbox-adapters';

export interface StreamProxyOptions {
  /** computerd's base URL (http/https); the ws scheme is derived. */
  computerdUrl: string;
  ticketSecret: string;
  log?: (fields: Record<string, unknown>, message: string) => void;
  /** Told once when a screen stream opens and once when it closes (presence: "watching your screen"). */
  onWatch?: (viewer: { ownerId: string; agentId: string }, watching: boolean) => void;
}

export interface StreamProxy {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

const PATH = /^\/v1\/screens\/([^/]+)\/vnc(?:\?|$)/;

export function createStreamProxy(opts: StreamProxyOptions): StreamProxy {
  const wss = new WebSocketServer({ noServer: true });
  const log = opts.log ?? (() => undefined);

  const refuse = (socket: Duplex, status: number, message: string) => {
    socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\nconnection: close\r\n\r\n${message}`);
    socket.destroy();
  };

  return {
    handleUpgrade(request, socket, head) {
      const match = PATH.exec(request.url ?? '');
      if (!match) return refuse(socket, 404, 'not a screen stream');
      const screenId = decodeURIComponent(match[1] ?? '');
      const ticket = new URL(request.url ?? '', 'http://agentd').searchParams.get('t');
      const claims = ticket ? verifyScreenTicket(ticket, opts.ticketSecret) : null;
      if (!claims || claims.screenId !== screenId) return refuse(socket, 403, 'invalid or expired ticket');

      const base = new URL(opts.computerdUrl);
      base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      const upstreamUrl = `${base.toString().replace(/\/$/, '')}/v1/screens/${encodeURIComponent(screenId)}/vnc?t=${encodeURIComponent(ticket ?? '')}`;

      const upstream = new WebSocket(upstreamUrl, parseProtocols(request.headers['sec-websocket-protocol']));
      const pending: RawData[] = [];
      wss.handleUpgrade(request, socket, head, (client) => {
        const closeBoth = (code: number, reason: string) => {
          if (client.readyState === WebSocket.OPEN) client.close(code, reason);
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code, reason);
        };
        let watched = false;
        const unwatch = () => {
          if (!watched || !claims) return;
          watched = false;
          opts.onWatch?.({ ownerId: claims.ownerId, agentId: claims.agentId }, false);
        };
        upstream.on('open', () => {
          for (const message of pending.splice(0)) upstream.send(message);
          log({ screenId }, 'public screen stream open');
          watched = true;
          opts.onWatch?.({ ownerId: claims.ownerId, agentId: claims.agentId }, true);
        });
        upstream.on('close', unwatch);
        client.on('close', unwatch);
        upstream.on('message', (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        });
        upstream.on('error', (error: Error) => {
          log({ err: error, screenId }, 'screen upstream error');
          closeBoth(1011, 'upstream error');
        });
        upstream.on('close', (code: number) => closeBoth(code === 1006 ? 1011 : code, 'upstream closed'));
        client.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
          else if (upstream.readyState === WebSocket.CONNECTING) pending.push(data);
        });
        client.on('close', () => closeBoth(1000, 'client closed'));
        client.on('error', (error: Error) => log({ err: error, screenId }, 'screen client error'));
      });
    },
  };
}

function parseProtocols(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const value = Array.isArray(header) ? header.join(',') : header;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}
