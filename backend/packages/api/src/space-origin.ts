/**
 * The Spaces preview handler (BACKEND 5.12), served by the API's own port for requests whose Host is under SPACE_DOMAIN: an agent's app, opened by its owner on its own subdomain
 * `<spaceId>.<SPACE_DOMAIN>`, so the app shares no origin, cookie or storage with the Juno app, the API or another app.
 *
 * Way in: the owner asks `POST /v1/spaces/:id/open-url` (logged in) and gets a 5-minute signed link to
 * `/__juno/auth?token=`. The handler verifies it and sets a host-only session cookie (HttpOnly, SameSite=Lax, Secure
 * over https, 12 hours) bound to {spaceId, ownerId}, then redirects to `/`. Every other request needs that cookie, loses
 * it (and every platform header) before going on, and is forwarded to the computer's gateway with `X-Juno-Space`
 * through computerd (which resumes a suspended computer and carries the traffic over the computer link). WebSocket upgrades go the same way. Requests that
 * state another origin and could change something (non-GET, WebSocket) are refused, so one app cannot act as the owner
 * in another through the same-site cookie.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import type { Store } from '@agent-desktop/contracts';
import { publishedSpace, type GatewayAddress } from './modules/spaces.js';
import { signToken, verifyToken } from './signed-token.js';

export const OPEN_URL_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'juno_space';
const SPACE_LABEL = /^[a-z0-9]{8,64}$/;

export type SpaceTokenKind = 'open' | 'session';

export interface SpaceTokenClaims {
  kind: SpaceTokenKind;
  spaceId: string;
  ownerId: string;
  expiresAt: number;
}

export function signSpaceToken(claims: SpaceTokenClaims, secret: string): string {
  return signToken(claims, secret);
}

/** The claims when genuine, of the wanted kind, for this space and not expired. */
export function verifySpaceToken(token: string, secret: string, kind: SpaceTokenKind, spaceId: string, now = Date.now()): SpaceTokenClaims | null {
  const value = verifyToken(token, secret);
  if (value === null) return null;
  if (value['kind'] !== kind || value['spaceId'] !== spaceId || typeof value['ownerId'] !== 'string' || typeof value['expiresAt'] !== 'number' || value['expiresAt'] <= now) return null;
  return { kind, spaceId, ownerId: value['ownerId'], expiresAt: value['expiresAt'] };
}

/** The space id when `host` is `<spaceId>.<domain>` (domain as configured, with its port when it has one). */
export function parseSpaceHost(host: string | undefined, domain: string): string | undefined {
  const lower = host?.toLowerCase();
  const suffix = '.' + domain.toLowerCase();
  if (lower === undefined || !lower.endsWith(suffix)) return undefined;
  const label = lower.slice(0, -suffix.length);
  return SPACE_LABEL.test(label) ? label : undefined;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** Headers for the request that goes on to the gateway: nothing of the platform, nothing hop-by-hop, our cookie removed. */
export function forwardHeaders(incoming: Headers, spaceId: string, host: string, proto: string, gatewayKey: string): Headers {
  const out = new Headers();
  for (const [name, value] of incoming) {
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'accept-encoding' || lower.startsWith('x-juno-') || lower.startsWith('x-forwarded-') || lower === 'x-owner-id' || lower === 'x-agent-id' || lower === 'forwarded') continue;
    if (['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding'].includes(lower)) continue;
    if (lower === 'cookie') {
      const rest = value.split(';').map((part) => part.trim()).filter((part) => part !== '' && !part.startsWith(SESSION_COOKIE + '='));
      if (rest.length > 0) out.set(name, rest.join('; '));
      continue;
    }
    out.append(name, value);
  }
  out.set('x-juno-space', spaceId);
  out.set('x-juno-gateway-key', gatewayKey);
  out.set('x-forwarded-host', host);
  out.set('x-forwarded-proto', proto);
  return out;
}

export interface SpaceOriginDeps {
  store: Store;
  secret: string;
  /** `spaces.localhost:8787`: the part after `<spaceId>.`, with its port when it has one. */
  domain: string;
  secure: boolean;
  /** Base URL of the owner's computer-side gateway (resumes the computer when paused). */
  gateway: (ownerId: string, fresh?: boolean) => Promise<GatewayAddress>;
  fetch?: typeof fetch;
}

export interface SpaceOrigin {
  app: Hono;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

const text = (status: number, message: string, extra: Record<string, string> = {}): Response =>
  new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra } });

export function createSpaceOrigin(deps: SpaceOriginDeps): SpaceOrigin {
  const proto = deps.secure ? 'https' : 'http';
  const send = deps.fetch ?? fetch;
  const wss = new WebSocketServer({ noServer: true });

  /** The owner behind a valid session cookie of this space, when the app is still theirs. */
  async function sessionOwner(spaceId: string, cookie: string | undefined): Promise<string | undefined> {
    const token = cookieValue(cookie, SESSION_COOKIE);
    const claims = token === undefined ? null : verifySpaceToken(token, deps.secret, 'session', spaceId);
    if (claims === null || deps.store.forOwner === undefined) return undefined;
    return (await publishedSpace(deps.store.forOwner(claims.ownerId), spaceId)) === null ? undefined : claims.ownerId;
  }

  /** Another page tried to act as the owner here: an Origin that is not this app's own. */
  const foreignOrigin = (origin: string | undefined, host: string): boolean => origin !== undefined && origin !== `${proto}://${host}`;

  const app = new Hono();
  app.all('*', async (c) => {
    const host = c.req.header('host') ?? '';
    const spaceId = parseSpaceHost(host, deps.domain);
    if (spaceId === undefined) return text(404, 'not found');
    const url = new URL(c.req.url);

    if (url.pathname === '/__juno/auth') {
      const claims = c.req.method === 'GET' ? verifySpaceToken(url.searchParams.get('token') ?? '', deps.secret, 'open', spaceId) : null;
      if (claims === null || deps.store.forOwner === undefined || (await publishedSpace(deps.store.forOwner(claims.ownerId), spaceId)) === null) return text(403, 'This link has expired. Open the app again from Juno.');
      const session = signSpaceToken({ kind: 'session', spaceId, ownerId: claims.ownerId, expiresAt: Date.now() + SESSION_TTL_MS }, deps.secret);
      const cookie = `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${deps.secure ? '; Secure' : ''}`;
      return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store' } });
    }

    const ownerId = await sessionOwner(spaceId, c.req.header('cookie'));
    if (ownerId === undefined) return text(401, 'Open this app from Juno.');
    const safeMethod = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (!safeMethod && foreignOrigin(c.req.header('origin'), host)) return text(403, 'Cross-origin request refused.');

    const attempt = async (fresh: boolean): Promise<Response> => {
      const gateway = await deps.gateway(ownerId, fresh);
      const headers = forwardHeaders(c.req.raw.headers, spaceId, host, proto, gateway.key);
      for (const [name, value] of Object.entries(gateway.headers)) headers.set(name, value);
      return send(new URL(url.pathname.slice(1) + url.search, gateway.url), {
        method: c.req.method,
        headers,
        body: safeMethod ? undefined : c.req.raw.body,
        redirect: 'manual',
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
    };
    let upstream: Response;
    try {
      upstream = await attempt(false).catch(() => attempt(true));
    } catch {
      return text(502, 'The computer behind this app is not answering.');
    }
    const out = new Headers();
    for (const [name, value] of upstream.headers) if (!['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'content-encoding', 'content-length'].includes(name)) out.append(name, value);
    for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
    if (!upstream.headers.has('content-encoding') && upstream.headers.has('content-length')) out.set('content-length', upstream.headers.get('content-length') ?? '0');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, reason: string) => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\n\r\n`);
      socket.destroy();
    };
    const host = request.headers.host ?? '';
    const spaceId = parseSpaceHost(host, deps.domain);
    if (spaceId === undefined) return refuse(404, 'Not Found');
    if (foreignOrigin(request.headers.origin, host)) return refuse(403, 'Forbidden');
    void (async () => {
      const ownerId = await sessionOwner(spaceId, request.headers.cookie);
      if (ownerId === undefined) return refuse(401, 'Unauthorized');
      const incoming = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) incoming.set(name, Array.isArray(value) ? value.join(', ') : value);
      const gateway = await deps.gateway(ownerId);
      const headers = forwardHeaders(incoming, spaceId, host, proto, gateway.key);
      for (const [name, value] of Object.entries(gateway.headers)) headers.set(name, value);
      for (const hop of ['upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) headers.delete(hop);
      const base = new URL(gateway.url);
      base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      const upstream = new WebSocket(new URL((request.url ?? '/').slice(1), base), protocols, { headers: Object.fromEntries(headers) });
      upstream.once('unexpected-response', (_req, response) => refuse(response.statusCode ?? 502, 'Bad Gateway'));
      upstream.once('error', () => refuse(502, 'Bad Gateway'));
      upstream.once('open', () => {
        wss.handleUpgrade(request, socket, head, (client) => {
          const closeBoth = (code: number, reason: Buffer | string) => {
            if (client.readyState === WebSocket.OPEN) client.close(code === 1005 || code === 1006 ? 1000 : code, reason);
            if (upstream.readyState === WebSocket.OPEN) upstream.close(code === 1005 || code === 1006 ? 1000 : code, reason);
          };
          upstream.on('message', (data, binary) => client.send(data, { binary }));
          client.on('message', (data, binary) => upstream.send(data, { binary }));
          upstream.on('close', closeBoth);
          client.on('close', closeBoth);
          upstream.on('error', () => closeBoth(1011, 'upstream error'));
          client.on('error', () => closeBoth(1011, 'client error'));
        });
      });
    })().catch(() => refuse(502, 'Bad Gateway'));
  }

  return { app, handleUpgrade };
}
