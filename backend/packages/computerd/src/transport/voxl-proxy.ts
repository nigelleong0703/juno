/**
 * The way from the public API to a display's voxl server (BACKEND 7.1b). The computer publishes no port, so the API's screen host sends
 * voxl's HTTP (its own web client, `/screenshot`, `/healthz`) and its WebSocket (`/ws`) HERE, and computerd carries them through the
 * computer link to the voxl listening on the computer's loopback.
 *
 * Calling convention: `/v1/screens/<screenId>/voxl/<path>` with the platform's credentials in `x-juno-computerd-token` and the
 * signed screen ticket in `x-juno-screen-ticket` (the same HMAC ticket the noVNC stream uses). Like the noVNC bridge, `control` on the
 * ticket grants nothing by itself: write access also needs the control row to say the person holds the screen at the ticket's epoch;
 * otherwise the request goes to the `--read-only` voxl. A writable WebSocket stays valid only while the row says so (re-read every
 * `revalidateMs`, and closed at once on a change in this process).
 *
 * voxl's own basic auth is filled in HERE (the per-screen password, never sent to a browser), and the request is rebuilt from an
 * allow-list of headers: no cookies, no Origin or Referer (voxl refuses browsers from other sites), `Host: localhost`.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { streamConnector, verifyScreenTicket, type ComputerProvider, type ScreenTicketClaims } from '@agent-desktop/sandbox-adapters';
import type { Lifecycle } from '../modules/computers/lifecycle.js';

export const TOKEN_HEADER = 'x-juno-computerd-token';
export const TICKET_HEADER = 'x-juno-screen-ticket';
const PATH = /^\/v1\/screens\/([^/?]+)\/voxl\/([^?]*)(\?.*)?$/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie', 'www-authenticate']);
/** What a browser's request may carry to voxl; everything else (cookies, Origin, Referer, forwarding headers, our credentials) is dropped. */
const REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since'] as const;
const METHODS = new Set(['GET', 'HEAD', 'POST']);
const REVALIDATE_MS = 2_000;

interface ComputerScope {
  lifecycle: Lifecycle;
  provider: ComputerProvider;
}

export interface VoxlProxyOptions {
  forOwner(owner: string): ComputerScope;
  /** computerd's bearer (`COMPUTERD_TOKEN`); the API presents it. */
  token: string;
  /** The ticket HMAC key (`SCREEN_TICKET_SECRET`). */
  secret: string;
  log?: (fields: Record<string, unknown>, message: string) => void;
  /** An open WebSocket holds the computer awake: renewed this often (0 disables; idle pausing off, or tests). */
  keepAliveMs?: number;
  revalidateMs?: number;
}

export interface VoxlProxy {
  matches(url: string | undefined): boolean;
  handleRequest(request: IncomingMessage, response: ServerResponse): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/** One request's resolved access to a display's voxl. */
interface Access {
  claims: ScreenTicketClaims;
  scope: ComputerScope;
  screenId: string;
  control: boolean;
  epoch: number;
  password: string;
  open(signal: AbortSignal): Promise<Duplex>;
}

class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createVoxlProxy(options: VoxlProxyOptions): VoxlProxy {
  const log = options.log ?? (() => undefined);
  const expected = Buffer.from(options.token);
  const wss = new WebSocketServer({ noServer: true });

  const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

  /** Who may talk to this proxy at all: the platform (token), holding a genuine ticket for exactly this screen. */
  function authorize(headers: IncomingHttpHeaders, screenId: string): ScreenTicketClaims {
    const given = first(headers[TOKEN_HEADER]);
    const actual = given === undefined ? Buffer.alloc(0) : Buffer.from(given);
    if (options.token === '' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Refusal(403, 'forbidden');
    const ticket = first(headers[TICKET_HEADER]);
    const claims = ticket === undefined ? null : verifyScreenTicket(ticket, options.secret);
    if (!claims || claims.screenId !== screenId) throw new Refusal(403, 'invalid or expired ticket');
    return claims;
  }

  async function resolve(headers: IncomingHttpHeaders, screenId: string): Promise<Access> {
    const claims = authorize(headers, screenId);
    const scope = options.forOwner(claims.ownerId);
    const screen = await scope.lifecycle.findById(screenId);
    if (!screen) throw new Refusal(404, 'unknown screen');
    if (screen.ownerId !== claims.ownerId || screen.agentId !== claims.agentId) throw new Refusal(403, 'ticket identity does not match screen');
    // Re-binds the SAME sandbox and display (never creates a VM) and re-runs the idempotent boot only when something is missing.
    const { binding } = await scope.lifecycle.requireScreen(screen.agentId, new AbortController().signal);
    const held = await scope.lifecycle.control.get({ kind: 'screen', screenId }, screen.agentId);
    const control = claims.control && held.holder === 'user' && (claims.epoch === undefined || claims.epoch === held.epoch);
    const secrets = scope.lifecycle.vncSecrets(screen);
    return {
      claims, scope, screenId, control, epoch: held.epoch,
      password: control ? secrets.controlPassword : secrets.viewPassword,
      open: (signal) => scope.provider.voxlStream(binding, screen.displayNo, control, signal),
    };
  }

  const parse = (url: string | undefined): { screenId: string; path: string; query: string } | null => {
    const match = PATH.exec(url ?? '');
    if (!match) return null;
    return { screenId: decodeURIComponent(match[1] ?? ''), path: match[2] ?? '', query: match[3] ?? '' };
  };

  const fail = (response: ServerResponse, status: number, message: string): void => {
    if (!response.headersSent) response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(message);
  };

  return {
    matches: (url) => url !== undefined && PATH.test(url),

    handleRequest(request, response) {
      const target = parse(request.url);
      if (!target) return fail(response, 404, 'not found');
      if (!METHODS.has(request.method ?? 'GET')) return fail(response, 405, 'method not allowed');
      const abort = new AbortController();
      response.on('close', () => abort.abort());
      void (async () => {
        const access = await resolve(request.headers, target.screenId);
        const headers: Record<string, string | string[]> = { host: 'localhost', authorization: `Bearer ${access.password}`, connection: 'close' };
        for (const name of REQUEST_HEADERS) {
          const value = request.headers[name];
          if (value !== undefined) headers[name] = value;
        }
        const upstream = httpRequest(
          { host: 'localhost', method: request.method ?? 'GET', path: `/${target.path}${target.query}`, headers, createConnection: streamConnector(() => access.open(abort.signal)) as never },
          (reply) => {
            if (reply.statusCode === 401) {
              // The password is ours; a refusal here is a platform fault, not something for the browser to answer with its own prompt.
              reply.resume();
              log({ screenId: target.screenId }, 'voxl refused the platform password');
              return fail(response, 502, 'the screen stream refused the platform credential');
            }
            const out: Record<string, string | string[]> = {};
            for (const [name, value] of Object.entries(reply.headers)) if (value !== undefined && !HOP.has(name)) out[name] = value;
            response.writeHead(reply.statusCode ?? 502, out);
            pipeline(reply, response, () => undefined);
          },
        );
        upstream.on('error', (error) => {
          log({ err: error, screenId: target.screenId }, 'voxl proxy request failed');
          fail(response, 502, 'the computer behind this screen is not answering');
        });
        pipeline(request, upstream, () => undefined);
      })().catch((error: unknown) => {
        if (error instanceof Refusal) return fail(response, error.status, error.message);
        log({ err: error, screenId: target.screenId }, 'voxl proxy setup failed');
        fail(response, 404, 'screen is not available');
      });
    },

    handleUpgrade(request, socket, head) {
      const refuse = (status: number, reason: string) => {
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\n\r\n`);
        socket.destroy();
      };
      const target = parse(request.url);
      // voxl has exactly one WebSocket, /ws; nothing else is bridged.
      if (!target || target.path !== 'ws') return refuse(404, 'Not Found');
      const abort = new AbortController();
      socket.on('close', () => abort.abort());
      void resolve(request.headers, target.screenId).then(
        (access) => {
          const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
          const upstream = new WebSocket(`ws://localhost/ws${target.query}`, protocols, {
            headers: { authorization: `Bearer ${access.password}` },
            createConnection: streamConnector(() => access.open(abort.signal)) as never,
          });
          upstream.once('unexpected-response', (_req, reply) => refuse(reply.statusCode === 401 ? 502 : (reply.statusCode ?? 502), 'Bad Gateway'));
          upstream.once('error', (error) => {
            log({ err: error, screenId: target.screenId }, 'voxl proxy upgrade failed');
            refuse(502, 'Bad Gateway');
          });
          upstream.once('open', () => wss.handleUpgrade(request, socket, head, (client) => bridge(client, upstream, access)));
        },
        (error: unknown) => {
          if (error instanceof Refusal) return refuse(error.status, error.message.slice(0, 40));
          log({ err: error, screenId: target.screenId }, 'voxl proxy setup failed');
          refuse(404, 'Not Found');
        },
      );
    },
  };

  function bridge(client: WebSocket, upstream: WebSocket, access: Access): void {
    const { provider, lifecycle } = access.scope;
    const holdId = `voxl-stream:${randomUUID()}`;
    const keepAliveMs = options.keepAliveMs ?? 0;
    const guards: Array<() => void> = [];
    let closed = false;
    const closeBoth = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      for (const stop of guards.splice(0)) stop();
      if (keepAliveMs > 0) provider.release(holdId);
      const safe = code === 1005 || code === 1006 ? 1000 : code;
      if (client.readyState === WebSocket.OPEN) client.close(safe, reason);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(safe, reason);
    };
    // Every open stream, watching or driving, holds its computer awake (BACKEND 7.3b).
    if (keepAliveMs > 0) {
      const renew = () => provider.hold(holdId, keepAliveMs * 3);
      renew();
      const timer = setInterval(renew, keepAliveMs);
      timer.unref();
      guards.push(() => clearInterval(timer));
    }
    if (access.control) {
      const surface = { kind: 'screen', screenId: access.screenId } as const;
      const stillMine = (state: { holder: string; epoch: number }) => state.holder === 'user' && state.epoch === access.epoch;
      let checking = false;
      const recheck = () => {
        if (checking) return;
        checking = true;
        lifecycle.control.get(surface).then((state) => { if (!stillMine(state)) closeBoth(1000, 'control revoked'); }, () => undefined).finally(() => { checking = false; });
      };
      guards.push(lifecycle.control.subscribe((state) => { if (state.id === `screen:${access.screenId}` && !stillMine(state)) closeBoth(1000, 'control revoked'); }));
      const timer = setInterval(recheck, options.revalidateMs ?? REVALIDATE_MS);
      timer.unref();
      guards.push(() => clearInterval(timer));
    }
    upstream.on('message', (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    client.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    });
    upstream.on('close', (code) => closeBoth(code, 'upstream closed'));
    client.on('close', (code) => closeBoth(code, 'client closed'));
    upstream.on('error', () => closeBoth(1011, 'upstream error'));
    client.on('error', () => closeBoth(1011, 'client error'));
    log({ screenId: access.screenId, control: access.control }, 'voxl stream open');
  }
}
