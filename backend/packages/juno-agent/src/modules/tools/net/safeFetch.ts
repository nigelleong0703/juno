/**
 * Server-side GET for `web_fetch` with the SSRF rule of BACKEND 8.0: every hop (the first URL and each redirect
 * target) is resolved, every resolved address must be public, and the socket is pinned to the address that was
 * checked, so a DNS answer that changes between check and connect cannot reach a private host (rebinding).
 * Redirects are followed by hand so each Location gets the same check. Transport and DNS are injectable.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isBlockedAddress, isBlockedHostname } from './addressGuard.js';

export class UnsafeTargetError extends Error {
  override name = 'UnsafeTargetError';
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface Hop {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
  truncated: boolean;
}

export interface RequestOptions {
  maxBytes: number;
  signal: AbortSignal;
  /** The Accept header; defaults to page types. */
  accept?: string;
}

export interface SafeFetchDeps {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (hop: Hop, options: RequestOptions) => Promise<RawResponse>;
}

export interface SafeFetchOptions extends SafeFetchDeps {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  maxRedirects?: number;
  accept?: string;
}

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

export async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

/**
 * Validates one hop and returns the address to connect to. Throws UnsafeTargetError for anything that is not a
 * public http(s) host. A name whose resolved addresses include any blocked one is refused as a whole.
 */
export async function checkHop(url: URL, resolve: (hostname: string) => Promise<ResolvedAddress[]> = defaultResolve): Promise<Hop> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeTargetError('Only http and https pages can be fetched');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const literal = isIP(host);
  if (literal !== 0) {
    if (isBlockedAddress(host)) throw new UnsafeTargetError('That address is a private or internal network address');
    return { url, address: host, family: literal === 4 ? 4 : 6 };
  }
  if (isBlockedHostname(host)) throw new UnsafeTargetError('That host is a local or internal name');
  const addresses = await resolve(host);
  if (addresses.length === 0) throw new UnsafeTargetError('That host did not resolve');
  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new UnsafeTargetError('That host resolves to a private or internal network address');
  }
  const first = addresses[0]!;
  return { url, address: first.address, family: first.family };
}

/** The default transport: node http/https with `lookup` pinned to the vetted address; the body is read up to maxBytes. */
function defaultRequest(hop: Hop, options: RequestOptions): Promise<RawResponse> {
  return new Promise<RawResponse>((resolvePromise, reject) => {
    const lib = hop.url.protocol === 'https:' ? https : http;
    const req = lib.request(
      hop.url,
      {
        method: 'GET',
        headers: {
          'user-agent': 'VomuAgent-web-fetch/1.0',
          accept: options.accept ?? 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
        },
        signal: options.signal,
        // Connects to the address checkHop vetted; the URL's hostname stays the TLS SNI and Host header.
        lookup: (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === 'object' && lookupOptions.all === true) {
            callback(null, [{ address: hop.address, family: hop.family }]);
          } else {
            callback(null, hop.address, hop.family);
          }
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          const room = options.maxBytes - total;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            total = options.maxBytes;
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        // A response cut off at the cap is destroyed, so 'close' (not 'end') is what settles it.
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            headers[name] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolvePromise({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated });
        };
        res.on('error', (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
        res.on('end', finish);
        res.on('close', finish);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET a public http(s) URL. Follows at most `maxRedirects` redirects, re-running checkHop on every target.
 * The total time budget covers DNS, connect and body; `signal` (the run's cancellation) aborts it too.
 */
export async function safeFetch(options: SafeFetchOptions): Promise<FetchedPage> {
  const resolve = options.resolve ?? defaultResolve;
  const request = options.request ?? defaultRequest;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let current = new URL(options.url);
    for (let hopCount = 0; ; hopCount += 1) {
      const hop = await checkHop(current, resolve);
      const response = await request(hop, { maxBytes: options.maxBytes, signal: controller.signal, ...(options.accept === undefined ? {} : { accept: options.accept }) });
      const location = response.headers.location;
      if (REDIRECT_STATUS.has(response.status) && location !== undefined && location !== '') {
        if (hopCount >= maxRedirects) throw new UnsafeTargetError('Too many redirects');
        current = new URL(location, current);
        continue;
      }
      // identity is requested; a server that compresses anyway would turn into unreadable text, so refuse it.
      const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
      if (encoding !== 'identity' && encoding !== '') throw new Error('the page came back compressed, which web_fetch does not read');
      const contentType = (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      return { finalUrl: current.href, status: response.status, contentType, body: response.body, truncated: response.truncated };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Text-like responses only; binary files are not readable through web_fetch. */
export function isTextContentType(contentType: string): boolean {
  return contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xhtml+xml' || contentType === 'application/xml';
}
