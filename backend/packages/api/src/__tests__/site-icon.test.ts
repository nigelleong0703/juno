import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SafeFetchDeps } from '@agent-desktop/contracts/net';
import { createApiApp, type ApiAuth } from '../server.js';
import { createMediaCache, createMediaRewriter } from '../media-proxy.js';
import { createSiteIconCache, deriveSiteIconKey, signedSiteIconUrl, siteIconUrlFor, verifySiteIconHost } from '../site-icon.js';

type Request = NonNullable<SafeFetchDeps['request']>;
const ORIGIN = 'http://127.0.0.1:8787';
const key = deriveSiteIconKey('artifact-secret');
const HOST = 'instagram.com';

const png = (side: number): Buffer => {
  const bytes = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(side, 16);
  bytes.writeUInt32BE(side, 20);
  return bytes;
};
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

type Reply = { body: Buffer | string; type?: string; status?: number; location?: string };
/** A fake web keyed by URL; unknown URLs are 404. */
function fakeWeb(site: Record<string, Reply>) {
  const request = vi.fn<Request>(async (hop) => {
    const reply = site[hop.url.href];
    if (reply === undefined) return { status: 404, headers: {}, body: Buffer.alloc(0), truncated: false };
    return { status: reply.status ?? 200, headers: { 'content-type': reply.type ?? 'image/png', location: reply.location }, body: Buffer.from(reply.body), truncated: false };
  });
  const resolve: SafeFetchDeps['resolve'] = async () => [{ address: '93.184.216.34', family: 4 }];
  return { request, deps: { resolve, request } as SafeFetchDeps };
}
const page = (head: string): Reply => ({ body: `<html><head>${head}</head></html>`, type: 'text/html' });

async function setup(site: Record<string, Reply>, now?: () => number) {
  const web = fakeWeb(site);
  const cache = createSiteIconCache({ dir: await mkdtemp(join(tmpdir(), 'site-icon-')), fetchDeps: web.deps, ...(now ? { now } : {}) });
  return { ...web, cache };
}
const fetched = (request: ReturnType<typeof fakeWeb>['request']): string[] => request.mock.calls.map(([hop]) => hop.url.href);

describe('site icon signature', () => {
  it('verifies a genuine signature and refuses forged, foreign-key and non-normalized hosts', () => {
    const [sig, host] = signedSiteIconUrl(ORIGIN, HOST, key).replace(ORIGIN + '/v1/site-icon/', '').split('/') as [string, string];
    expect(verifySiteIconHost(sig, host, key)).toBe(HOST);
    expect(verifySiteIconHost('AAAA', host, key)).toBeNull();
    expect(verifySiteIconHost(sig, 'other.com', key)).toBeNull();
    expect(verifySiteIconHost(sig, host, deriveSiteIconKey('other'))).toBeNull();
    for (const bad of ['Instagram.com', 'instagram.com:8080', 'user@instagram.com', '127.0.0.1', 'localhost', 'a_b.com', '-a.com', `${'a'.repeat(64)}.com`]) {
      expect(verifySiteIconHost(signedSiteIconUrl(ORIGIN, bad, key).split('/')[4]!, bad, key)).toBeNull();
    }
  });
});

describe('site icon search', () => {
  it('prefers the largest apple-touch-icon over the favicon', async () => {
    const { cache } = await setup({
      [`https://${HOST}/`]: page('<link rel="icon" href="/fav.png" sizes="64x64"><link rel="apple-touch-icon" href="/small.png" sizes="60x60"><link rel="apple-touch-icon-precomposed" href="/big.png" sizes="180x180">'),
      [`https://${HOST}/fav.png`]: { body: png(64) },
      [`https://${HOST}/small.png`]: { body: png(60) },
      [`https://${HOST}/big.png`]: { body: png(180) },
    });
    expect((await cache.get(HOST))?.bytes.equals(png(180))).toBe(true);
  });

  it('falls through apple-touch-icon.png, icon links and /favicon.ico, skipping svg, tiny and failing candidates', async () => {
    const { cache, request } = await setup({
      [`https://${HOST}/`]: page('<link rel="shortcut icon" href="/logo.svg"><link rel="icon" href="/tiny.png"><link rel="icon" href="http://insecure.example/x.png">'),
      [`https://${HOST}/logo.svg`]: { body: SVG, type: 'image/svg+xml' },
      [`https://${HOST}/tiny.png`]: { body: png(16) },
      [`https://${HOST}/favicon.ico`]: { body: png(48) },
    });
    expect((await cache.get(HOST))?.bytes.equals(png(48))).toBe(true);
    expect(fetched(request)).toEqual([`https://${HOST}/`, `https://${HOST}/apple-touch-icon.png`, `https://${HOST}/logo.svg`, `https://${HOST}/tiny.png`, `https://${HOST}/favicon.ico`]);
  });

  it('serves a hit from disk, shares concurrent searches, re-searches after 30 days, and remembers a miss briefly', async () => {
    let now = Date.now();
    const { cache, request } = await setup({ [`https://${HOST}/apple-touch-icon.png`]: { body: png(120) } }, () => now);
    await Promise.all([cache.get(HOST), cache.get(HOST)]);
    const calls = request.mock.calls.length;
    expect((await cache.get(HOST))?.contentType).toBe('image/png');
    expect(request).toHaveBeenCalledTimes(calls);
    now += 31 * 24 * 60 * 60 * 1000;
    await cache.get(HOST);
    expect(request.mock.calls.length).toBeGreaterThan(calls);

    const empty = await setup({});
    expect(await empty.cache.get('nothing.example')).toBeNull();
    const misses = empty.request.mock.calls.length;
    expect(await empty.cache.get('nothing.example')).toBeNull();
    expect(empty.request).toHaveBeenCalledTimes(misses);
  });

  it('refuses private addresses and a redirect to http', async () => {
    const web = fakeWeb({ [`https://${HOST}/apple-touch-icon.png`]: { body: png(120) } });
    const privateCache = createSiteIconCache({ dir: await mkdtemp(join(tmpdir(), 'site-icon-')), fetchDeps: { ...web.deps, resolve: async () => [{ address: '10.0.0.5', family: 4 }] } });
    expect(await privateCache.get(HOST)).toBeNull();
    expect(web.request).not.toHaveBeenCalled();

    const redirected = await setup({
      [`https://${HOST}/apple-touch-icon.png`]: { body: '', status: 302, location: 'http://cdn.example.com/icon.png' },
      [`https://${HOST}/favicon.ico`]: { body: '', status: 302, location: 'http://cdn.example.com/icon.png' },
      'http://cdn.example.com/icon.png': { body: png(120) },
    });
    expect(await redirected.cache.get(HOST)).toBeNull();
  });
});

const auth: ApiAuth = { info: { mode: 'account', providers: ['credential'] }, handle: async () => new Response(), resolve: async () => ({ ownerId: 'o1' }) };

async function gateway(site: Record<string, Reply>, upstream: () => Response = () => Response.json({})) {
  const { cache, request, deps } = await setup(site);
  const media = { key: Buffer.from('m'), cache: createMediaCache({ dir: await mkdtemp(join(tmpdir(), 'media-')), fetchDeps: deps }), origin: ORIGIN };
  const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: (async () => upstream()) as typeof fetch, media, siteIcon: { key, cache, origin: ORIGIN } });
  return { app, request };
}

describe('site icon route', () => {
  it('serves a signed host without a session, with hardened headers', async () => {
    const { app } = await gateway({ [`https://${HOST}/favicon.ico`]: { body: png(64) } });
    const res = await app.request(signedSiteIconUrl(ORIGIN, HOST, key).replace(ORIGIN, ''));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('404s a bad signature without fetching and 502s a site without an icon', async () => {
    const { app, request } = await gateway({});
    expect((await app.request(`/v1/site-icon/AAAA/${HOST}`)).status).toBe(404);
    expect(request).not.toHaveBeenCalled();
    const res = await app.request(signedSiteIconUrl(ORIGIN, HOST, key).replace(ORIGIN, ''));
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('response rewrite', () => {
  const approval = { id: 'a1', platform: { kind: 'site', host: HOST, name: 'Instagram' }, other: { platform: { kind: 'app', host: HOST } } };

  it('adds iconUrl to site platforms only, in JSON and without touching the input', async () => {
    const { app } = await gateway({}, () => Response.json({ items: [approval, { platform: { kind: 'site', host: 'Bad Host' } }] }));
    const body = (await (await app.request('/v1/feed')).json()) as { items: Array<typeof approval> };
    expect(body.items[0]!.platform).toEqual({ ...approval.platform, iconUrl: signedSiteIconUrl(ORIGIN, HOST, key) });
    expect(body.items[0]!.other.platform).toEqual(approval.other.platform);
    expect(body.items[1]!.platform).not.toHaveProperty('iconUrl');

    const rewriter = createMediaRewriter({ origin: ORIGIN, key: Buffer.from('m'), cache: createMediaCache({ dir: tmpdir() }), siteIconUrl: siteIconUrlFor({ origin: ORIGIN, key }) });
    const stored = structuredClone(approval);
    rewriter.rewrite(stored);
    expect(stored).toEqual(approval);
  });

  it('rewrites SSE data lines', async () => {
    const line = `event: approval.requested\ndata: ${JSON.stringify({ approval })}\n\n`;
    const { app } = await gateway({}, () => new Response(line, { headers: { 'content-type': 'text/event-stream' } }));
    expect(await (await app.request('/v1/events')).text()).toContain(signedSiteIconUrl(ORIGIN, HOST, key));
  });
});
