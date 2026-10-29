/**
 * The computer link endpoint (BACKEND §7.11): the one door computers use. Every computer's `juno-link` daemon dials
 * `wss://<computerd>/v1/computer-link` and authenticates with its per-computer token in the first frame; nothing else is
 * served here, so this listener can face the computers' network while the main API stays on loopback.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { MAX_FRAME } from 'juno-link/protocol';
import type { LinkHub } from '@agent-desktop/sandbox-adapters';

export const LINK_PATH = '/v1/computer-link';

export function createLinkServer(hub: LinkHub): Server {
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  const wss = new WebSocketServer({ server, path: LINK_PATH, maxPayload: MAX_FRAME });
  // ws re-emits the http server's errors (a taken port) on itself; an unhandled one kills the process, and the caller of listen() already handles it.
  wss.on('error', () => {});
  wss.on('connection', (socket) => hub.accept(socket));
  return server;
}

/** The same door on a server that is already listening (the desktop engine serves it on its own port): hand it the `upgrade` events for LINK_PATH. */
export function createLinkUpgrade(hub: LinkHub): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  wss.on('connection', (socket) => hub.accept(socket));
  return (request, socket, head) => wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
}
