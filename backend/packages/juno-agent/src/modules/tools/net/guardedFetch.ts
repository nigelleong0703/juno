/**
 * A fetch-compatible client for outbound MCP traffic (connect flow, OAuth discovery, token and registration
 * calls, and the streamable-HTTP transport). Every hop goes through safeFetch's `checkHop` (every resolved
 * address public, socket pinned to the checked address), redirects are followed by hand and each target is
 * checked again, and a cross-origin redirect drops the caller's credentials. Bodies stream, so SSE works.
 *
 * MCP_ALLOW_PRIVATE_HOSTS=1 (tests and local development only, default off) skips the address check and
 * nothing else: the request still goes through this client. It is read at call time.
 *
 * The MCP servers our own gateway hosts (HOSTED_MCP_PATH under BETTER_AUTH_URL, its public origin) skip the
 * address check too: that origin is ours and may be loopback (dev) or a private network address.
 */

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { targetsPrivateNetwork } from './addressGuard.js';
import { checkHop, defaultResolve, type ResolvedAddress } from './safeFetch.js';

export const MCP_ALLOW_PRIVATE_HOSTS = 'MCP_ALLOW_PRIVATE_HOSTS';
const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([204, 205, 304]);
/** `x-upstream-authorization` is the caller's Google/Microsoft token on a hosted connector request (modules/mcp/platform-keys.ts); like `authorization` it never follows a cross-origin redirect. */
const CREDENTIAL_HEADERS = ['authorization', 'x-upstream-authorization', 'cookie', 'proxy-authorization'] as const;
const DEFAULT_MAX_REDIRECTS = 5;

export function privateHostsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env[MCP_ALLOW_PRIVATE_HOSTS] === '1';
}

/** Where the gateway serves the MCP servers it hosts (api modules/google-mcp.ts). */
export const HOSTED_MCP_PATH = '/mcp/google/';

/** Exactly our own public origin (BETTER_AUTH_URL). */
function isOwnOrigin(url: URL, env: Record<string, string | undefined>): boolean {
  const own = env['BETTER_AUTH_URL'];
  if (own === undefined || own === '') return false;
  try {
    return url.origin === new URL(own).origin;
  } catch {
    return false;
  }
}

function isHostedPath(path: string): boolean {
  return path.startsWith(HOSTED_MCP_PATH);
}

/**
 * The stored form of an MCP endpoint our own gateway hosts (BACKEND 10.18.5): the path alone, never an origin, so a changed public
 * origin (BETTER_AUTH_URL) cannot orphan it. This is the one test that decides where the hosted credential (HOSTED_MCP_TOKEN) is sent:
 * a custom server's endpoint is always an absolute http(s) URL and can never have this form.
 */
export function isStoredHostedEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('/') && !endpoint.startsWith('//') && isHostedPath(endpoint);
}

/** The stored form of a URL that points at a hosted path on any origin (an install, a migration); undefined for every other URL. */
export function hostedPathOfUrl(raw: string): string | undefined {
  try {
    const { pathname } = new URL(raw);
    return isHostedPath(pathname) ? pathname : undefined;
  } catch {
    return undefined;
  }
}

/** The URL a stored hosted endpoint is called at: the current public origin plus its path. Absent without a public origin. */
export function hostedEndpointUrl(endpoint: string, publicOrigin: string | undefined): string | undefined {
  if (publicOrigin === undefined || publicOrigin === '') return undefined;
  return publicOrigin.replace(/\/+$/, '') + endpoint;
}

/** A stored endpoint or OAuth `resource` as the URL it is used at: a hosted path gets the current public origin, any other value is already a URL. */
export function storedEndpointUrl(stored: string, publicOrigin: string | undefined): string | undefined {
  return isStoredHostedEndpoint(stored) ? hostedEndpointUrl(stored, publicOrigin) : stored;
}

/** A URL of an MCP server our own gateway hosts, or its resource metadata: exactly its public origin and the hosted path. */
export function isOwnHostedMcp(url: URL, env: Record<string, string | undefined> = process.env): boolean {
  return isOwnOrigin(url, env) && (isHostedPath(url.pathname) || url.pathname.startsWith('/.well-known/oauth-protected-resource' + HOSTED_MCP_PATH));
}

/**
 * Refused before any request: a non-http(s) URL, a private host by name (no DNS), or a hosted connector path on any origin (those are
 * internal and only their catalog entries use them; a custom server pointing there is refused, like any other URL this refuses).
 * Used at creation time and when a custom server is probed.
 */
export function mcpUrlRefused(raw: string, env: Record<string, string | undefined> = process.env): boolean {
  try {
    if (isHostedPath(new URL(raw).pathname)) return true;
  } catch {
    return true;
  }
  if (!privateHostsAllowed(env)) return targetsPrivateNetwork(raw);
  try {
    const url = new URL(raw);
    return url.protocol !== 'http:' && url.protocol !== 'https:';
  } catch {
    return true;
  }
}

/** For model endpoints: refused like an MCP URL (loopback and LAN addresses included). */
export function modelUrlRefused(raw: string): boolean {
  return mcpUrlRefused(raw);
}

/** One outbound attempt. `address` is absent only when the dev escape hatch skips the address check. */
export interface PinnedHop {
  url: URL;
  address?: string;
  family?: 4 | 6;
}

export interface PinnedInit {
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
  signal: AbortSignal | undefined;
}

export interface RawStreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  stream: Readable;
}

export interface GuardedFetchDeps {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (hop: PinnedHop, init: PinnedInit) => Promise<RawStreamResponse>;
  allowPrivate?: () => boolean;
  maxRedirects?: number;
  /** Keep sockets between requests (the model client): the address was vetted when the request was made, and every request is vetted again. */
  agents?: PinnedAgents;
}

/** Connection pools for a transport that keeps its sockets between requests. */
export interface PinnedAgents {
  http: http.Agent;
  https: https.Agent;
}

/** The real transport: node http/https, lookup pinned to the vetted address; no pooling unless `agents` are given (every request then opens its own socket). */
function pinnedRequest(hop: PinnedHop, init: PinnedInit, agents?: PinnedAgents): Promise<RawStreamResponse> {
  return new Promise<RawStreamResponse>((resolvePromise, reject) => {
    const lib = hop.url.protocol === 'https:' ? https : http;
    const address = hop.address;
    const family = hop.family ?? 4;
    const options: https.RequestOptions = {
      method: init.method,
      headers: init.headers,
      agent: agents === undefined ? false : hop.url.protocol === 'https:' ? agents.https : agents.http,
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    };
    if (address !== undefined) {
      options.lookup = (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === 'object' && lookupOptions.all === true) callback(null, [{ address, family }]);
        else callback(null, address, family);
      };
    }
    const req = lib.request(hop.url, options, (res) => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, stream: res }));
    req.on('error', reject);
    req.end(init.body);
  });
}

function bytesOf(body: RequestInit['body']): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('the MCP HTTP client only sends string, URLSearchParams or binary bodies');
}

function toResponse(raw: RawStreamResponse): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  if (NULL_BODY_STATUS.has(raw.status)) {
    raw.stream.destroy();
    return new Response(null, { status: raw.status, headers });
  }
  return new Response(Readable.toWeb(raw.stream) as unknown as ReadableStream<Uint8Array>, { status: raw.status, headers });
}

export function createGuardedFetch(deps: GuardedFetchDeps = {}): typeof fetch {
  const resolve = deps.resolve ?? defaultResolve;
  const send = deps.request ?? ((hop: PinnedHop, init: PinnedInit) => pinnedRequest(hop, init, deps.agents));
  const allowPrivate = deps.allowPrivate ?? (() => privateHostsAllowed());
  const maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const source = input instanceof Request ? input : undefined;
    let url = new URL(source?.url ?? String(input));
    let method = (init.method ?? source?.method ?? 'GET').toUpperCase();
    const headers = new Headers(source?.headers);
    if (init.headers !== undefined) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    let body = init.body !== undefined ? bytesOf(init.body) : source !== undefined && source.body !== null ? Buffer.from(await source.arrayBuffer()) : undefined;
    if (body !== undefined) headers.set('content-length', String(body.byteLength));
    const redirectMode = init.redirect ?? source?.redirect ?? 'follow';
    const signal = init.signal ?? source?.signal ?? undefined;

    for (let hopCount = 0; ; hopCount += 1) {
      // The escape hatch skips only the address judgement; the request is still made through this client.
      const hop: PinnedHop = allowPrivate() || isOwnHostedMcp(url) ? { url } : await checkHop(url, resolve);
      const raw = await send(hop, { method, headers: Object.fromEntries(headers), body, signal });
      const location = raw.headers.location;
      if (REDIRECT_STATUS.has(raw.status) && typeof location === 'string' && location !== '' && redirectMode !== 'manual') {
        raw.stream.destroy();
        if (redirectMode === 'error') throw new TypeError('the MCP HTTP request was redirected and redirects are refused');
        if (hopCount >= maxRedirects) throw new TypeError('the MCP HTTP request followed too many redirects');
        const next = new URL(location, url);
        if (next.origin !== url.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
        // Same rules as the fetch standard: 303, and 301/302 on POST, become a bodiless GET; 307/308 replay it.
        if (raw.status === 303 || ((raw.status === 301 || raw.status === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET';
          body = undefined;
          headers.delete('content-length');
          headers.delete('content-type');
        }
        url = next;
        continue;
      }
      return toResponse(raw);
    }
  }) as typeof fetch;
}

/** The MCP default: every MCP outbound request uses this unless a caller injects its own fetch. */
export const guardedFetch: typeof fetch = createGuardedFetch();

/** The client for a model provider's endpoint: guarded like MCP. */
export function createModelFetch(): typeof fetch {
  return createGuardedFetch({ agents: modelAgents });
}

/** Shared by every model client: a voice turn seconds after the last one finds the TLS connection still open (a handshake is ~0.4 s). */
const MODEL_SOCKET_IDLE_MS = 30_000;
const modelAgents: PinnedAgents = {
  http: new http.Agent({ keepAlive: true, maxFreeSockets: 8, timeout: MODEL_SOCKET_IDLE_MS }),
  https: new https.Agent({ keepAlive: true, maxFreeSockets: 8, timeout: MODEL_SOCKET_IDLE_MS }),
};
