/**
 * A feed post's picture (BACKEND §10.10): the agent chooses it after looking at the candidates (web_fetch shows an image);
 * `verifyFeedImage` is only the technical gate: it downloads the chosen URL through the SSRF-safe fetch and checks that it is a
 * real, large enough raster picture. `pageImageUrls` lists a page's own candidates (og:image, twitter:image, JSON-LD image).
 */
import { createHash } from 'node:crypto';
import { safeFetch, type SafeFetchDeps } from '../tools/net/safeFetch.js';
import { imageSize, sniffImage } from '../tools/net/imageInfo.js';

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 8_000;
const MIN_WIDTH = 600;
const MIN_ASPECT = 1 / 1.2;
const MAX_ASPECT = 2.4;
/** Article inline pictures may be tall infographics or wide charts: the cover crop does not apply. */
const ARTICLE_MIN_ASPECT = 1 / 4;
const ARTICLE_MAX_ASPECT = 4;
const MAX_CANDIDATES = 3;
const META = /<meta\b[^>]*>/gi;
const JSON_LD = /<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;

/** Names that mark a logo, icon, placeholder or avatar; `default` only counts in the file name (Drupal's /sites/default/files is a real path). */
const NOT_A_PHOTO = /logo|icon|sprite|placeholder|avatar|favicon|apple-touch/i;
const DEFAULT_NAME = /default/i;

export function httpsUrl(raw: string, base?: string): string | undefined {
  try {
    const url = new URL(raw, base);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** URLs that name a logo, icon, sprite, placeholder, default or avatar image: no image beats one of these. */
export function looksLikeLogo(url: string): boolean {
  const path = new URL(url).pathname;
  return NOT_A_PHOTO.test(path) || DEFAULT_NAME.test(path.slice(path.lastIndexOf('/') + 1)) || /default[-_]?share/i.test(path);
}

function metaAttr(tag: string, name: string): string | undefined {
  return new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag)?.slice(1).find((part) => part !== undefined);
}

/** Every `image` / `thumbnailUrl` string in a JSON-LD value (a string, an {url} object, or an array of them). */
function ldImages(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) ldImages(item, out, depth + 1); return; }
  const record = value as Record<string, unknown>;
  for (const key of ['image', 'thumbnailUrl']) {
    const found = record[key];
    for (const item of Array.isArray(found) ? found : [found]) {
      if (typeof item === 'string') out.push(item);
      else if (item !== null && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') out.push((item as { url: string }).url);
    }
  }
  for (const nested of Object.values(record)) ldImages(nested, out, depth + 1);
}

/** The page's own picture candidates as https URLs, best first, read from its HTML (`baseUrl` resolves relative links). */
export function pageImageUrls(html: string, baseUrl: string): string[] {
  const found = new Map<string, string>();
  for (const tag of html.match(META) ?? []) {
    const key = (metaAttr(tag, 'property') ?? metaAttr(tag, 'name'))?.toLowerCase();
    const content = metaAttr(tag, 'content');
    if (key !== undefined && content !== undefined && !found.has(key)) found.set(key, content.replace(/&amp;/g, '&').trim());
  }
  const width = Number(found.get('og:image:width'));
  const height = Number(found.get('og:image:height'));
  // A stated size under 400px, or a small square, is a logo or icon; the page's real picture is larger.
  const small = (width > 0 && width < 400) || (height > 0 && height < 400) || (width > 0 && width === height && width <= 512);
  const raw: Array<[string, string]> = ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'].flatMap((key) => {
    const value = found.get(key);
    return value === undefined || value === '' || (small && key.startsWith('og:')) ? [] : [[key, value] as [string, string]];
  });
  const ld: string[] = [];
  for (const block of html.matchAll(JSON_LD)) {
    try { ldImages(JSON.parse(block[1] ?? ''), ld); } catch { /* malformed JSON-LD */ }
  }
  const urls = [...raw.map(([, value]) => value), ...ld].map((value) => httpsUrl(value, baseUrl)).filter((url): url is string => url !== undefined && !looksLikeLogo(url));
  return [...new Set(urls)].slice(0, MAX_CANDIDATES);
}

export interface SeenImages {
  /** Normalized URLs already used by this routine's posts lately. */
  urls: ReadonlySet<string>;
  /** sha256 (hex) of image bytes already used by this routine's posts lately. */
  hashes: ReadonlySet<string>;
}

export type VerifiedImage = { ok: true; url: string; sha256: string } | { ok: false; reason: string };

/**
 * Downloads `url` through the SSRF-safe fetch and accepts it only as a real raster picture: png/jpeg/webp/gif/avif by
 * magic bytes (never svg), at least 600px wide, aspect between 1:1.2 and 2.4:1, not a logo/icon/placeholder by name, and
 * not already used by the same routine's recent posts (by URL or by content hash).
 */
export type FeedImageShape = 'cover' | 'article';

export async function verifyFeedImage(url: string, opts: { deps?: SafeFetchDeps; signal: AbortSignal; seen?: SeenImages; normalize: (url: string) => string; shape?: FeedImageShape }): Promise<VerifiedImage> {
  const https = httpsUrl(url);
  if (https === undefined) return { ok: false, reason: 'not https' };
  if (looksLikeLogo(https)) return { ok: false, reason: 'looks like a logo or placeholder' };
  if (opts.seen?.urls.has(opts.normalize(https))) return { ok: false, reason: 'image already used' };
  try {
    const file = await safeFetch({ url: https, maxBytes: IMAGE_MAX_BYTES, timeoutMs: IMAGE_TIMEOUT_MS, signal: opts.signal, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9', ...opts.deps });
    if (file.status < 200 || file.status >= 300 || file.truncated) return { ok: false, reason: 'download failed' };
    if (new URL(file.finalUrl).protocol !== 'https:') return { ok: false, reason: 'redirected off https' };
    if (sniffImage(file.body) === null) return { ok: false, reason: 'not a raster image' };
    const size = imageSize(file.body);
    if (size === null) return { ok: false, reason: 'unreadable size' };
    if (size.width < MIN_WIDTH) return { ok: false, reason: 'too small' };
    const aspect = size.width / Math.max(size.height, 1);
    const minAspect = opts.shape === 'article' ? ARTICLE_MIN_ASPECT : MIN_ASPECT;
    const maxAspect = opts.shape === 'article' ? ARTICLE_MAX_ASPECT : MAX_ASPECT;
    if (aspect < minAspect || aspect > maxAspect) return { ok: false, reason: 'odd aspect ratio' };
    const sha256 = createHash('sha256').update(file.body).digest('hex');
    if (opts.seen?.hashes.has(sha256)) return { ok: false, reason: 'image already used' };
    return { ok: true, url: https, sha256 };
  } catch {
    return { ok: false, reason: 'download failed' };
  }
}
