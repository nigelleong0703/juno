/**
 * The way from the public API to a computer's Spaces gateway (BACKEND 5.12, §7.11). The computer publishes no port, so the
 * API sends the app's HTTP and WebSocket traffic HERE and computerd carries it through the computer link to the gateway on
 * 127.0.0.1:7090 (resuming the computer if it is suspended). The gateway key stays: the API still sends `X-Juno-Gateway-Key`
 * and the gateway still demands it.
 *
 * Calling convention: `/v1/spaces/gateway-proxy/<path>` with the platform's credentials in `x-juno-computerd-token` and
 * `x-juno-owner` (not `authorization`, which belongs to the app and is passed on untouched). Both headers are removed before
 * the request reaches the computer.
 */
import { timingSafeEqual } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream';
import { streamConnector, type ComputerProvider } from '@agent-desktop/sandbox-adapters';
import type { E2bBinding } from '@agent-desktop/contracts';

export const GATEWAY_PROXY_PREFIX = '/v1/spaces/gateway-proxy/';
const TOKEN_HEADER = 'x-juno-computerd-token';
const OWNER_HEADER = 'x-juno-owner';
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding']);

interface OwnerScope {
  provider: ComputerProvider;
  currentBinding(): E2bBinding | null;
}

export interface GatewayProxyOptions {
  token: string;
  scopeFor(owner: string): OwnerScope;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

export interface GatewayProxy {
  matches(url: string | undefined): boolean;
  handleRequest(request: IncomingMessage, response: ServerResponse): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createGatewayProxy(options: GatewayProxyOptions): GatewayProxy {
  const log = options.log ?? (() => undefined);
  const expected = Buffer.from(options.token);

  function authorized(headers: IncomingHttpHeaders): string | undefined {
    const given = headers[TOKEN_HEADER];
    const owner = headers[OWNER_HEADER];
    if (typeof given !== 'string' || typeof owner !== 'string' || owner.trim() === '' || options.token === '') return undefined;
    const actual = Buffer.from(given);
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? owner : undefined;
  }

  /** The computer's gateway as a byte stream (resuming it), plus the request headers without the platform's own. */
  async function open(owner: string, signal: AbortSignal): Promise<Duplex> {
    const scope = options.scopeFor(owner);
    const binding = scope.currentBinding();
    if (binding === null) throw new Error('this account has no computer');
    return scope.provider.gatewayStream(binding, signal);
  }

  const forwardable = (headers: IncomingHttpHeaders, keepUpgrade: boolean): Record<string, string | string[]> => {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || name === TOKEN_HEADER || name === OWNER_HEADER) continue;
      if (!keepUpgrade && HOP.has(name)) continue;
      out[name] = value;
    }
    return out;
  };
  const gatewayPath = (url: string) => '/' + url.slice(GATEWAY_PROXY_PREFIX.length);

  return {
    matches: (url) => url !== undefined && url.startsWith(GATEWAY_PROXY_PREFIX),

    handleRequest(request, response) {
      const owner = authorized(request.headers);
      if (owner === undefined) return void response.writeHead(403).end('forbidden');
      const abort = new AbortController();
      response.on('close', () => abort.abort());
      const fail = (status: number) => {
        if (!response.headersSent) response.writeHead(status, { 'content-type': 'text/plain' });
        response.end(status === 502 ? 'the computer behind this app is not answering' : 'error');
      };
      const upstream = httpRequest(
        {
          host: 'gateway',
          method: request.method ?? 'GET',
          path: gatewayPath(request.url ?? ''),
          headers: { ...forwardable(request.headers, false), connection: 'close' },
          createConnection: streamConnector(() => open(owner, abort.signal)) as never,
        },
        (reply) => {
          const headers: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(reply.headers)) if (value !== undefined && !HOP.has(name)) headers[name] = value;
          response.writeHead(reply.statusCode ?? 502, headers);
          pipeline(reply, response, () => undefined);
        },
      );
      upstream.on('error', (error) => {
        log({ err: error, owner }, 'gateway proxy request failed');
        fail(502);
      });
      pipeline(request, upstream, () => undefined);
    },

    handleUpgrade(request, socket, head) {
      const owner = authorized(request.headers);
      const refuse = (status: string) => {
        socket.write(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
        socket.destroy();
      };
      if (owner === undefined) return refuse('403 Forbidden');
      const abort = new AbortController();
      socket.on('close', () => abort.abort());
      open(owner, abort.signal).then(
        (stream) => {
          // A WebSocket upgrade is forwarded as the bytes it is: the request line and headers (minus ours) go in, the
          // gateway's 101 and everything after come back untouched.
          const headers = forwardable(request.headers, true);
          const lines = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((one) => `${name}: ${one}`));
          stream.write(`${request.method ?? 'GET'} ${gatewayPath(request.url ?? '')} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
          if (head.length > 0) stream.write(head);
          socket.pipe(stream);
          stream.pipe(socket);
          stream.on('close', () => socket.destroy());
          socket.on('close', () => stream.destroy());
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        },
        (error: unknown) => {
          log({ err: error, owner }, 'gateway proxy upgrade failed');
          refuse('502 Bad Gateway');
        },
      );
    },
  };
}
