/** Minimal promise wrappers for websocket events in tests. */
import type { WebSocket, WebSocketServer } from 'ws';

export function serverListening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => server.once('listening', () => resolve()));
}

export function socketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('open', () => resolve()));
}

