/**
 * The site-icon proxy (BACKEND 5.13): an approval request stores only a site host; the response layer turns it into a
 * signed URL `/v1/site-icon/<sig>/<host>` that serves that site's icon from a disk cache. Like the media proxy the
 * signature is the capability, and every fetch goes through the SSRF-safe fetcher (https only, also after redirects).
 */
import type { Hono } from 'hono';
import { imageSize, safeFetch, type SafeFetchDeps } from '@agent-desktop/contracts/net';
import { createStoredImageCache, deriveKey, fetchImage, imageResponse, isSignatureOf, sign, type MediaImage } from './media-proxy.js';

const MAX_ICON_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MIN_SIDE = 32;
const MAX_PER_GROUP = 2;
const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HTML_TIMEOUT_MS = 10_000;

export const deriveSiteIconKey = (secret: string): Buffer => deriveKey(secret, 'juno-site-icon-v1');

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lowercase DNS name with at least one dot and a non-numeric last label: no port, userinfo, IP literal or single-label host. */
export function isSiteHost(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split('.');
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^\d+$/.test(labels[labels.length - 1]!);
}

export function signedSiteIconUrl(origin: string, host: string, key: Buffer): string {
  return `${origin.replace(/\/$/, '')}/v1/site-icon/${sign(host, key)}/${host}`;
}

/** The host when the signature is genuine and the host is a valid lowercase DNS name, else null. */
export function verifySiteIconHost(sig: string, host: string, key: Buffer): string | null {
  return isSiteHost(host) && isSignatureOf(sig, host, key) ? host : null;
}

/** For the response rewriter: the signed icon URL of a host, null when the host is not a valid site host. */
export const siteIconUrlFor = (deps: { origin: string; key: Buffer }) => (host: string): string | null => (isSiteHost(host) ? signedSiteIconUrl(deps.origin, host, deps.key) : null);

const attr = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.replaceAll('&amp;', '&');
};

/** The `<link>` icon hrefs of one kind, largest declared `sizes` first. */
function linkIcons(html: string, base: string, wanted: (rel: string[]) => boolean): string[] {
  const found: Array<{ href: string; area: number }> = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    const href = attr(tag, 'href');
    if (href === undefined || !wanted(rel)) continue;
    try {
      const url = new URL(href, base);
      if (url.protocol === 'https:') found.push({ href: url.href, area: Math.max(0, ...[...(attr(tag, 'sizes') ?? '').matchAll(/(\d+)x(\d+)/gi)].map((m) => Number(m[1]) * Number(m[2]))) });
    } catch {
      // an unparseable href is skipped
    }
  }
  return found.sort((a, b) => b.area - a.area).map((icon) => icon.href);
}

async function pageHtml(host: string, deps: SafeFetchDeps | undefined): Promise<{ html: string; base: string }> {
  const fallback = { html: '', base: `https://${host}/` };
  try {
    const page = await safeFetch({ url: fallback.base, maxBytes: MAX_HTML_BYTES, timeoutMs: HTML_TIMEOUT_MS, maxRedirects: 3, accept: 'text/html', ...deps });
    return page.status === 200 && page.finalUrl.startsWith('https://') ? { html: page.body.toString('utf8'), base: page.finalUrl } : fallback;
  } catch {
    return fallback;
  }
}

async function usableIcon(url: string, deps: SafeFetchDeps | undefined): Promise<MediaImage | null> {
  const image = await fetchImage(url, deps, MAX_ICON_BYTES);
  const size = image === null ? null : imageSize(image.bytes);
  return image !== null && (size === null || Math.min(size.width, size.height) >= MIN_SIDE) ? image : null;
}

/** The first acceptable icon: apple-touch-icon links, /apple-touch-icon.png, icon links, /favicon.ico. */
async function findIcon(host: string, deps: SafeFetchDeps | undefined): Promise<MediaImage | null> {
  const { html, base } = await pageHtml(host, deps);
  const apple = linkIcons(html, base, (rel) => rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed'));
  const plain = linkIcons(html, base, (rel) => rel.includes('icon'));
  const candidates = [
    ...apple.slice(0, MAX_PER_GROUP),
    new URL('/apple-touch-icon.png', base).href,
    ...plain.slice(0, MAX_PER_GROUP),
    new URL('/favicon.ico', base).href,
  ];
  for (const url of new Set(candidates)) {
    const image = await usableIcon(url, deps);
    if (image !== null) return image;
  }
  return null;
}

export interface SiteIconCacheOptions {
  dir: string;
  fetchDeps?: SafeFetchDeps;
  now?: () => number;
}

export interface SiteIconCache {
  /** The icon of a site host: from disk (30 days), else found once (concurrent callers share the search); null when the site has none. */
  get: (host: string) => Promise<MediaImage | null>;
}

export function createSiteIconCache(options: SiteIconCacheOptions): SiteIconCache {
  return createStoredImageCache({ dir: options.dir, ...(options.now ? { now: options.now } : {}), maxAgeMs: SUCCESS_TTL_MS, produce: (host) => findIcon(host, options.fetchDeps) });
}

/** `GET /v1/site-icon/:sig/:host`; registered before the session middleware, the signature is the only credential. */
export function registerSiteIconRoute(app: Hono, deps: { cache: SiteIconCache; key: Buffer }): void {
  app.get('/v1/site-icon/:sig/:host', async (c) => {
    const host = verifySiteIconHost(c.req.param('sig'), c.req.param('host'), deps.key);
    if (host === null) return c.text('not found', 404, { 'Cache-Control': 'no-store' });
    return imageResponse(await deps.cache.get(host));
  });
}
