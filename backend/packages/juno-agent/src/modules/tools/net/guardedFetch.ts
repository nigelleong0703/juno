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
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const;
const DEFAULT_MAX_REDIRECTS = 5;

export function privateHostsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env[MCP_ALLOW_PRIVATE_HOSTS] === '1';
}

/** Where the gateway serves the MCP servers it hosts (api modules/google-mcp.ts). */
export const HOSTED_MCP_PATH = '/mcp/google/';
/** Where it serves the Singapore data servers (api modules/sg-mcp.ts). */
export const SG_MCP_PATH = '/mcp/sg/';
/** Hevy (api modules/hevy-mcp.ts): hosted here too, under its own path. */
const HEVY_MCP_PATH = '/mcp/hevy';

/** A URL of an MCP server our own gateway hosts, or its resource metadata: exactly its public origin and the hosted path. */
export function isOwnHostedMcp(url: URL, env: Record<string, string | undefined> = process.env): boolean {
  const own = env['BETTER_AUTH_URL'];
  if (own === undefined || own === '') return false;
  try {
    return url.origin === new URL(own).origin && (url.pathname === HEVY_MCP_PATH || [HOSTED_MCP_PATH, SG_MCP_PATH].some((path) => url.pathname.startsWith(path) || url.pathname.startsWith('/.well-known/oauth-protected-resource' + path)));
  } catch {
    return false;
  }
}

/** Refused before any request: a non-http(s) URL, or a private host by name (no DNS). Used at creation time. */
export function mcpUrlRefused(raw: string, env: Record<string, string | undefined> = process.env): boolean {
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
}

/** The real transport: node http/https, no agent pooling, lookup pinned to the vetted address. */
function pinnedRequest(hop: PinnedHop, init: PinnedInit): Promise<RawStreamResponse> {
  return new Promise<RawStreamResponse>((resolvePromise, reject) => {
    const lib = hop.url.protocol === 'https:' ? https : http;
    const address = hop.address;
    const family = hop.family ?? 4;
    const options: https.RequestOptions = {
      method: init.method,
      headers: init.headers,
      agent: false,
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
  const send = deps.request ?? pinnedRequest;
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
  return createGuardedFetch();
}
