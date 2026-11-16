/**
 * The screen host (BACKEND 7.1b): voxl's own browser client and its WebSocket, served on SCREEN_HOST at `/s/<signed ticket>/...` by the
 * API's own port (Host dispatch, like the artifact and Spaces hosts). The ticket is the existing short-lived screen ticket (HMAC,
 * `SCREEN_TICKET_SECRET`; it says which screen, whose, and whether the person may drive it). There is no cookie, no login and no API
 * middleware here; the host serves nothing but the streamer's own static client and its stream.
 *
 * Everything is forwarded to computerd (`voxl-proxy.ts` there), which re-checks the ticket and the screen's CURRENT controller, picks
 * the control or the `--read-only` voxl, fills in voxl's password and carries the bytes through the computer link. The password never
 * reaches the browser. voxl's client uses relative URLs (`client.js`, `worker.js`, `ws`), so the page must be opened as `/s/<ticket>/`
 * (a request without the slash is redirected), and the same prefix then carries every asset and the socket.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { verifyScreenTicket, type ScreenTicketClaims } from '@agent-desktop/sandbox-adapters';

const TICKET_PATH = /^\/s\/([^/]+)(\/.*)?$/;
const FORWARD_REQUEST = ['accept', 'accept-language', 'content-type', 'range', 'if-none-match', 'if-modified-since'];
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'content-encoding', 'content-length', 'www-authenticate']);

export interface ScreenOriginDeps {
  secret: string;
  /** computerd's base URL and bearer (`COMPUTERD_URL`, `COMPUTERD_TOKEN`); an empty token switches the host off (503). */
  computerd: { url: string; token: string };
  /** `http` or `https`, as browsers reach this host (EDGE_SCHEME); decides which Origin its own page has. */
  scheme: 'http' | 'https';
  /** Origins of the apps allowed to embed the client in an iframe (CSP frame-ancestors). */
  frameAncestors: readonly string[];
  log?: (fields: Record<string, unknown>, message: string) => void;
  /** Told when a stream opens and closes (presence: "watching your screen"), like the noVNC stream. */
  onWatch?: (viewer: { ownerId: string; agentId: string }, watching: boolean) => void;
  fetch?: typeof fetch;
}

export interface ScreenOrigin {
  app: Hono;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/** `/s/<ticket>/<rest>`: the ticket's claims and what to ask voxl for, or null for a path that is not one or a ticket that is not genuine. */
export function parseScreenPath(pathname: string, secret: string, now = Date.now()): { ticket: string; claims: ScreenTicketClaims; rest: string | undefined } | null {
  const match = TICKET_PATH.exec(pathname);
  if (!match) return null;
  const ticket = match[1] ?? '';
  const claims = verifyScreenTicket(ticket, secret, now);
  return claims ? { ticket, claims, rest: match[2]?.slice(1) } : null;
}

const text = (status: number, message: string, extra: Record<string, string> = {}): Response =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });

export function createScreenOrigin(deps: ScreenOriginDeps): ScreenOrigin {
  const log = deps.log ?? (() => undefined);
  const send = deps.fetch ?? fetch;
  const wss = new WebSocketServer({ noServer: true });
  const credentials = (ticket: string): Record<string, string> => ({ 'x-juno-computerd-token': deps.computerd.token, 'x-juno-screen-ticket': ticket });
  const computerdPath = (claims: ScreenTicketClaims, rest: string, search: string) => `/v1/screens/${encodeURIComponent(claims.screenId)}/voxl/${rest}${search}`;
  /** An Origin that is not this host's own: another page acting through a ticket URL it learned. */
  const foreignOrigin = (origin: string | undefined, host: string): boolean => origin !== undefined && origin !== `${deps.scheme}://${host}`;

  const app = new Hono();
  app.all('*', async (c) => {
    if (deps.computerd.token === '') return text(503, 'screen streaming is not configured');
    const url = new URL(c.req.url);
    const parsed = parseScreenPath(url.pathname, deps.secret);
    if (!parsed) return text(403, 'This link has expired. Open the screen again from Juno.');
    // voxl's client builds its URLs relative to the page, so the page has to live under `/s/<ticket>/`.
    if (parsed.rest === undefined) return new Response(null, { status: 308, headers: { location: `${url.pathname}/${url.search}`, 'cache-control': 'no-store' } });
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return text(405, 'method not allowed');
    if (method === 'POST' && foreignOrigin(c.req.header('origin'), c.req.header('host') ?? '')) return text(403, 'Cross-origin request refused.');

    const headers = new Headers(credentials(parsed.ticket));
    for (const name of FORWARD_REQUEST) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    let upstream: Response;
    try {
      upstream = await send(new URL(computerdPath(parsed.claims, parsed.rest, url.search), deps.computerd.url), {
        method,
        headers,
        body: method === 'POST' ? c.req.raw.body : undefined,
        redirect: 'manual',
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
    } catch (error) {
      log({ err: error, screenId: parsed.claims.screenId }, 'screen host request failed');
      return text(502, 'The computer behind this screen is not answering.');
    }
    const out = new Headers();
    for (const [name, value] of upstream.headers) if (!DROP_RESPONSE.has(name)) out.append(name, value);
    out.set('cache-control', 'private, no-store');
    out.set('x-content-type-options', 'nosniff');
    out.set('referrer-policy', 'no-referrer');
    out.set('content-security-policy', `frame-ancestors ${deps.frameAncestors.join(' ') || "'none'"}`);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, reason: string) => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (deps.computerd.token === '') return refuse(503, 'Service Unavailable');
    const url = new URL(request.url ?? '/', 'http://screen');
    const parsed = parseScreenPath(url.pathname, deps.secret);
    if (!parsed || parsed.rest !== 'ws') return refuse(parsed ? 404 : 403, parsed ? 'Not Found' : 'Forbidden');
    if (foreignOrigin(request.headers.origin, request.headers.host ?? '')) return refuse(403, 'Forbidden');
    const base = new URL(deps.computerd.url);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    const upstream = new WebSocket(new URL(computerdPath(parsed.claims, 'ws', url.search), base), protocols, { headers: credentials(parsed.ticket) });
    const pending: Array<{ data: RawData; binary: boolean }> = [];
    upstream.once('unexpected-response', (_req, reply) => refuse(reply.statusCode ?? 502, 'Bad Gateway'));
    upstream.once('error', (error) => {
      log({ err: error, screenId: parsed.claims.screenId }, 'screen host upgrade failed');
      refuse(502, 'Bad Gateway');
    });
    const viewer = { ownerId: parsed.claims.ownerId, agentId: parsed.claims.agentId };
    wss.handleUpgrade(request, socket, head, (client) => {
      let watched = false;
      const unwatch = () => {
        if (!watched) return;
        watched = false;
        deps.onWatch?.(viewer, false);
      };
      const closeBoth = (code: number, reason: string) => {
        const safe = code === 1005 || code === 1006 ? 1000 : code;
        if (client.readyState === WebSocket.OPEN) client.close(safe, reason);
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(safe, reason);
      };
      upstream.removeAllListeners('error');
      upstream.removeAllListeners('unexpected-response');
      upstream.on('open', () => {
        for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary });
        watched = true;
        deps.onWatch?.(viewer, true);
      });
      upstream.on('message', (data, binary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      });
      client.on('message', (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, binary });
      });
      upstream.on('close', (code) => { unwatch(); closeBoth(code, 'upstream closed'); });
      client.on('close', () => { unwatch(); closeBoth(1000, 'client closed'); });
      upstream.on('error', (error) => { log({ err: error, screenId: parsed.claims.screenId }, 'screen host upstream error'); closeBoth(1011, 'upstream error'); });
      client.on('error', () => closeBoth(1011, 'client error'));
    });
  }

  return { app, handleUpgrade };
}
