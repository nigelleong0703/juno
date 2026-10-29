/**
 * The image proxy (BACKEND 5.13): external image URLs in responses and live events become signed URLs on this API's own
 * origin, `/v1/media/<sig>/<base64url(url)>`, served from a disk cache. The signature is the capability (no login, so
 * `<img>` works cross-origin); the first request fetches through the SSRF-safe fetcher, later ones never touch the source.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { rewriteMarkdownImageUrls, safeFetch, sniffImage, type SafeFetchDeps } from '@agent-desktop/contracts/net';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const MAX_URL_LENGTH = 2000;

/** Feed article Markdown tops out at 6000 chars per schema; longer `body` strings skip parsing so a hostile upstream cannot buy CPU here. */
const MAX_FEED_BODY_CHARS = 32768;

/** A signing key derived from an existing secret so no new required setting exists; the label keeps it apart from the URLs that secret signs directly. */
export function deriveKey(secret: string, label: string): Buffer {
  return createHmac('sha256', secret).update(label).digest();
}

export const deriveMediaKey = (secret: string): Buffer => deriveKey(secret, 'juno-media-proxy-v1');

export const sign = (value: string, key: Buffer): string => createHmac('sha256', key).update(value).digest('base64url');

/** Constant-time check that `sig` is the signature of `value`. */
export function isSignatureOf(sig: string, value: string, key: Buffer): boolean {
  const expected = Buffer.from(sign(value, key));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function signedMediaUrl(origin: string, url: string, key: Buffer): string {
  return `${origin.replace(/\/$/, '')}/v1/media/${sign(url, key)}/${Buffer.from(url, 'utf8').toString('base64url')}`;
}

/** The original URL when the signature is genuine (constant-time compare), else null. */
export function verifyMediaUrl(sig: string, encoded: string, key: Buffer): string | null {
  if (encoded.length > MAX_URL_LENGTH * 2) return null;
  const url = Buffer.from(encoded, 'base64url').toString('utf8');
  return isSignatureOf(sig, url, key) ? url : null;
}

export interface MediaImage {
  bytes: Buffer;
  contentType: string;
}

export interface MediaCacheOptions {
  dir: string;
  fetchDeps?: SafeFetchDeps;
  now?: () => number;
}

export interface MediaCache {
  /** The image for a URL: from disk, else fetched once (concurrent callers share the fetch); null when it cannot be had. */
  get: (url: string) => Promise<MediaImage | null>;
  /** Fire-and-forget `get` so the picture is stored before the source can remove it. */
  warm: (url: string) => void;
}

/** One GET of an image over https (also after redirects): the sniffed raster image, or null for anything else (svg, truncated, non-200, private address). */
export async function fetchImage(url: string, fetchDeps: SafeFetchDeps | undefined, maxBytes = MAX_IMAGE_BYTES): Promise<MediaImage | null> {
  try {
    if (new URL(url).protocol !== 'https:') return null;
    const page = await safeFetch({
      url,
      maxBytes,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9',
      ...fetchDeps,
    });
    const contentType = page.status === 200 && !page.truncated && new URL(page.finalUrl).protocol === 'https:' ? sniffImage(page.body) : null;
    return contentType === null ? null : { bytes: page.body, contentType };
  } catch {
    return null;
  }
}

export interface StoredImageCacheOptions {
  dir: string;
  now?: () => number;
  /** Files older than this are fetched again; absent keeps them forever. */
  maxAgeMs?: number;
  /** Gets the image for a key from its source. */
  produce: (key: string) => Promise<MediaImage | null>;
}

/** Disk cache keyed by sha256(key), a 10 minute in-memory memory of failures, and one shared fetch per key at a time. */
export function createStoredImageCache(options: StoredImageCacheOptions): { get: (key: string) => Promise<MediaImage | null> } {
  const now = options.now ?? Date.now;
  const inflight = new Map<string, Promise<MediaImage | null>>();
  const failedUntil = new Map<string, number>();

  const fileFor = (key: string): string => join(options.dir, createHash('sha256').update(key).digest('hex'));

  async function fromDisk(key: string): Promise<MediaImage | null> {
    try {
      const file = fileFor(key);
      if (options.maxAgeMs !== undefined && now() - (await stat(file)).mtimeMs > options.maxAgeMs) return null;
      const bytes = await readFile(file);
      const contentType = sniffImage(bytes);
      return contentType === null ? null : { bytes, contentType };
    } catch {
      return null;
    }
  }

  async function fetchAndStore(key: string): Promise<MediaImage | null> {
    const image = await options.produce(key);
    if (image === null) return null;
    try {
      await mkdir(options.dir, { recursive: true });
      const target = fileFor(key);
      await writeFile(target + '.tmp', image.bytes);
      await rename(target + '.tmp', target);
    } catch {
      return null;
    }
    return image;
  }

  async function load(key: string): Promise<MediaImage | null> {
    const cached = await fromDisk(key);
    if (cached !== null) return cached;
    if ((failedUntil.get(key) ?? 0) > now()) return null;
    const fetched = await fetchAndStore(key);
    if (fetched === null) failedUntil.set(key, now() + NEGATIVE_TTL_MS);
    return fetched;
  }

  return {
    get(key) {
      const running = inflight.get(key);
      if (running !== undefined) return running;
      const started = load(key).finally(() => inflight.delete(key));
      inflight.set(key, started);
      return started;
    },
  };
}

export function createMediaCache(options: MediaCacheOptions): MediaCache {
  const cache = createStoredImageCache({ dir: options.dir, ...(options.now ? { now: options.now } : {}), produce: (url) => fetchImage(url, options.fetchDeps) });
  return { get: cache.get, warm: (url) => void cache.get(url) };
}

/** The hardened response for a cached image; 502 when there is none. */
export function imageResponse(image: MediaImage | null): Response {
  if (image === null) return new Response('bad gateway', { status: 502, headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'no-store' } });
  return new Response(new Uint8Array(image.bytes), {
    status: 200,
    headers: {
      'Content-Type': image.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

/** `GET /v1/media/:sig/:encodedUrl`; registered before the session middleware, the signature is the only credential. */
export function registerMediaRoute(app: Hono, deps: { cache: MediaCache; key: Buffer }): void {
  app.get('/v1/media/:sig/:encoded', async (c) => {
    const url = verifyMediaUrl(c.req.param('sig'), c.req.param('encoded'), deps.key);
    if (url === null) return c.text('not found', 404, { 'Cache-Control': 'no-store' });
    return imageResponse(await deps.cache.get(url));
  });
}

/** A plain object map without casting: `Object.entries` sources narrow here instead. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A Feed article (list/detail posts and feed.created/feed.updated event posts): the only objects whose
 * Markdown `body` gets image signing. Feed refs carry no body; drafts and other prose carry no `title`+`liked`.
 */
function isFeedArticle(value: Record<string, unknown>): boolean {
  return typeof value.title === 'string' && typeof value.liked === 'boolean';
}

/**
 * A loopback gateway origin (dev `BETTER_AUTH_URL`): signed media URLs on it are unreachable from a
 * remote phone, so a non-loopback incoming request origin takes over (see `effectiveOrigin`).
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    // Strict 127/8: a public domain merely starting with `127.` (127.example.com) is never loopback.
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export interface MediaRewriter {
  /**
   * A copy of `value` whose external https `imageUrl` strings and Feed article Markdown `body` picture
   * destinations are signed proxy URLs; the input is never mutated. `requestOrigin` is the incoming
   * request URL: with a loopback dev config it moves signing onto a non-loopback request origin.
   */
  rewrite: (value: unknown, requestOrigin?: string) => unknown;
  /** Rewrites JSON text; text without an `imageUrl`, `body` (or, with site icons on, `platform`) key passes through untouched. */
  rewriteJson: (text: string, requestOrigin?: string) => string;
}

export function createMediaRewriter(deps: {
  origin: string;
  key: Buffer;
  cache: MediaCache;
  ownOrigins?: readonly string[];
  /**
   * Edge TLS scheme (EDGE_SCHEME): an edge proxy may terminate TLS in front of a
   * plain-http API, so signed media URLs use this scheme instead of the request or
   * configured origin scheme. Absent preserves local-dev behaviour. Only this
   * explicit setting counts; forwarded headers are never read (callers pass raw.url).
   */
  edgeScheme?: 'http' | 'https';
  /** Signed icon URL for a site host, null for an invalid host; when set, a `platform: { kind: 'site', host }` object gets an `iconUrl`. */
  siteIconUrl?: (host: string) => string | null;
}): MediaRewriter {
  const own = new Set([new URL(deps.origin).origin, ...(deps.ownOrigins ?? [])]);
  const configuredLoopback = isLoopbackOrigin(deps.origin);
  /** Signed URLs use the edge scheme for the externally reached origin, else the origin as reached. */
  const applyEdgeScheme = (origin: string): string => {
    if (deps.edgeScheme === undefined) return origin;
    try {
      const url = new URL(origin);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        url.protocol = deps.edgeScheme + ':';
        return url.origin;
      }
    } catch {
      return origin;
    }
    return origin;
  };
  /**
   * The origin signed media URLs point at: the configured public origin, except a loopback dev config
   * serves a non-loopback incoming gateway origin so a remote phone gets reachable URLs. The edge
   * scheme applies to that external origin (and to an explicit public origin); a loopback dev config
   * answering loopback requests keeps its plain origin even with the edge scheme set, so local
   * clients on plain HTTP keep working. Only the request line's own origin counts; forwarded
   * headers are never read here (callers pass `raw.url`).
   */
  const effectiveOrigin = (requestOrigin?: string): string => {
    if (!configuredLoopback) return applyEdgeScheme(deps.origin);
    if (requestOrigin === undefined) return deps.origin;
    try {
      const incoming = new URL(requestOrigin);
      const http = incoming.protocol === 'http:' || incoming.protocol === 'https:';
      if (!http || isLoopbackOrigin(incoming.origin)) return deps.origin;
      return applyEdgeScheme(incoming.origin);
    } catch {
      return deps.origin;
    }
  };
  /** External to both the configured origin and the effective signing origin, so already-signed remote URLs are never proxied twice. */
  const external = (value: string, origin: string): boolean => {
    if (!value.startsWith('https://') || value.length > MAX_URL_LENGTH) return false;
    try {
      const urlOrigin = new URL(value).origin;
      return urlOrigin !== origin && !own.has(urlOrigin);
    } catch {
      return false;
    }
  };
  const withSiteIcon = (platform: unknown): unknown => {
    if (typeof platform !== 'object' || platform === null || Array.isArray(platform)) return undefined;
    const { kind, host } = platform as { kind?: unknown; host?: unknown };
    const iconUrl = kind === 'site' && typeof host === 'string' ? deps.siteIconUrl?.(host) : null;
    return iconUrl ? { ...(rewrite(platform) as Record<string, unknown>), iconUrl } : undefined;
  };
  /**
   * Feed article Markdown with external https picture destinations signed to own-origin cached URLs;
   * prose, source links, captions, fences and inline code pass through untouched.
   */
  const signFeedBody = (body: string, origin: string): string => {
    if (!body.includes('![') || body.length > MAX_FEED_BODY_CHARS) return body;
    return rewriteMarkdownImageUrls(body, (url) => {
      if (!external(url, origin)) return undefined;
      deps.cache.warm(url);
      return signedMediaUrl(origin, url, deps.key);
    });
  };
  const rewrite = (value: unknown, requestOrigin?: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => rewrite(item, requestOrigin));
    if (!isRecord(value)) return value;
    const origin = effectiveOrigin(requestOrigin);
    const feed = isFeedArticle(value);
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) {
      const withIcon = name === 'platform' ? withSiteIcon(child) : undefined;
      if (withIcon !== undefined) {
        out[name] = withIcon;
      } else if (feed && name === 'body' && typeof child === 'string') {
        out[name] = signFeedBody(child, origin);
      } else if (name === 'imageUrl' && typeof child === 'string' && external(child, origin)) {
        deps.cache.warm(child);
        out[name] = signedMediaUrl(origin, child, deps.key);
      } else {
        out[name] = rewrite(child, requestOrigin);
      }
    }
    return out;
  };
  const rewriteJson = (text: string, requestOrigin?: string): string => {
    if (!text.includes('"imageUrl"') && !text.includes('"body"') && !(deps.siteIconUrl !== undefined && text.includes('"platform"'))) return text;
    try {
      return JSON.stringify(rewrite(JSON.parse(text), requestOrigin));
    } catch {
      return text;
    }
  };
  return { rewrite, rewriteJson };
}

/**
 * Rewrites the `data:` lines of a forwarded SSE stream (agentd writes one JSON object per line); other
 * lines pass through. `requestOrigin` is the incoming request URL, rebasing loopback dev signing.
 */
export function rewriteSseStream(body: ReadableStream<Uint8Array>, rewriter: MediaRewriter, requestOrigin?: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const line = (text: string): string => (text.startsWith('data: ') ? 'data: ' + rewriter.rewriteJson(text.slice(6), requestOrigin) : text);
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        if (lines.length > 0) controller.enqueue(encoder.encode(lines.map(line).join('\n') + '\n'));
      },
      flush(controller) {
        if (pending !== '') controller.enqueue(encoder.encode(line(pending)));
      },
    }),
  );
}
