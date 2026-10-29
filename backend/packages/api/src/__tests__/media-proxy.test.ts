import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SafeFetchDeps } from '@agent-desktop/contracts/net';
import { createApiApp, type ApiAuth } from '../server.js';
import { MAX_IMAGE_BYTES, createMediaCache, createMediaRewriter, deriveMediaKey, signedMediaUrl, type MediaCache } from '../media-proxy.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const ORIGIN = 'http://127.0.0.1:8787';
const SOURCE = 'https://cdn.example.com/pic.jpg';
const key = deriveMediaKey('artifact-secret');

const publicResolve: SafeFetchDeps['resolve'] = async () => [{ address: '93.184.216.34', family: 4 }];
const respondWith = (body: Buffer, extra: { truncated?: boolean; status?: number } = {}) =>
  vi.fn(async () => ({ status: extra.status ?? 200, headers: { 'content-type': 'image/png' }, body, truncated: extra.truncated ?? false }));

async function setup(request: ReturnType<typeof respondWith>, resolve = publicResolve) {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  const cache = createMediaCache({ dir, fetchDeps: { resolve, request } });
  return { cache, request, dir };
}

const auth: ApiAuth = { info: { mode: 'account', providers: ['credential'] }, handle: async () => new Response(), resolve: async () => ({ ownerId: 'o1' }) };

async function gateway(upstream: () => Response, request = respondWith(PNG)) {
  const { cache } = await setup(request);
  const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: (async () => upstream()) as typeof fetch, media: { key, cache, origin: ORIGIN } });
  return { app, request };
}

describe('signed media route', () => {
  it('serves a signed URL without a session, with hardened headers', async () => {
    const { app } = await gateway(() => Response.json({}));
    const res = await app.request(signedMediaUrl(ORIGIN, SOURCE, key).replace(ORIGIN, ''));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('404s a forged signature, a tampered URL and a signature from another key', async () => {
    const { app, request } = await gateway(() => Response.json({}));
    const [sig, encoded] = signedMediaUrl(ORIGIN, SOURCE, key).replace(ORIGIN + '/v1/media/', '').split('/') as [string, string];
    const other = Buffer.from('https://evil.example/x.png').toString('base64url');
    expect((await app.request(`/v1/media/${sig}/${other}`)).status).toBe(404);
    expect((await app.request(`/v1/media/AAAA/${encoded}`)).status).toBe(404);
    const foreign = signedMediaUrl(ORIGIN, SOURCE, deriveMediaKey('other')).replace(ORIGIN, '');
    expect((await app.request(foreign)).status).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('media cache', () => {
  it('fetches once and then serves from disk; concurrent first requests share one fetch', async () => {
    const { cache, request } = await setup(respondWith(PNG));
    const [a, b] = await Promise.all([cache.get(SOURCE), cache.get(SOURCE)]);
    expect(a?.contentType).toBe('image/png');
    expect(b?.bytes.equals(PNG)).toBe(true);
    expect((await cache.get(SOURCE))?.contentType).toBe('image/png');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refuses private addresses, http, svg and oversized bodies, and remembers a failure briefly', async () => {
    const privateHost = await setup(respondWith(PNG), async () => [{ address: '10.0.0.5', family: 4 }]);
    expect(await privateHost.cache.get(SOURCE)).toBeNull();
    const loopback = await setup(respondWith(PNG));
    expect(await loopback.cache.get('https://127.0.0.1/pic.png')).toBeNull();
    expect(await loopback.cache.get('http://cdn.example.com/pic.png')).toBeNull();
    expect(loopback.request).not.toHaveBeenCalled();
    const svg = await setup(respondWith(SVG));
    expect(await svg.cache.get(SOURCE)).toBeNull();
    const big = await setup(respondWith(Buffer.alloc(MAX_IMAGE_BYTES), { truncated: true }));
    expect(await big.cache.get(SOURCE)).toBeNull();
    await svg.cache.get(SOURCE);
    expect(svg.request).toHaveBeenCalledTimes(1);
  });

  it('answers 502 for an upstream failure', async () => {
    const { app } = await gateway(() => Response.json({}), respondWith(SVG));
    expect((await app.request(signedMediaUrl(ORIGIN, SOURCE, key).replace(ORIGIN, ''))).status).toBe(502);
  });
});

describe('response rewrite', () => {
  const post = { id: 'p1', imageUrl: SOURCE, ui: { blocks: [{ type: 'items', rows: [{ name: 'a', imageUrl: 'https://cdn.example.com/a.png' }] }] } };

  it('rewrites external imageUrl in JSON, leaves own-origin URLs, and warms the cache', async () => {
    const own = ORIGIN + '/v1/library/x/download';
    const { app, request } = await gateway(() => Response.json({ items: [post, { id: 'p2', imageUrl: own }] }));
    const body = (await (await app.request('/v1/feed')).json()) as { items: Array<typeof post> };
    expect(body.items[0]!.imageUrl).toBe(signedMediaUrl(ORIGIN, SOURCE, key));
    expect((body.items[0]!.ui.blocks[0] as { rows: Array<{ imageUrl: string }> }).rows[0]!.imageUrl).toMatch(/^http:\/\/127\.0\.0\.1:8787\/v1\/media\//);
    expect(body.items[1]!.imageUrl).toBe(own);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it('rewrites SSE data lines across chunk boundaries', async () => {
    const line = `id: 1\nevent: feed.created\ndata: ${JSON.stringify({ type: 'feed.created', post })}\n\n`;
    const half = Math.floor(line.length / 2);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(line.slice(0, half))); c.enqueue(encoder.encode(line.slice(half))); c.close(); } });
    const { app } = await gateway(() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    const text = await (await app.request('/v1/events')).text();
    expect(text).toContain(signedMediaUrl(ORIGIN, SOURCE, key));
    expect(text).not.toContain('"imageUrl":"' + SOURCE);
    expect(text.startsWith('id: 1\nevent: feed.created\n')).toBe(true);
  });

  it('does not mutate the stored object', async () => {
    const { cache } = await setup(respondWith(PNG));
    const { createMediaRewriter } = await import('../media-proxy.js');
    const stored = structuredClone(post);
    const out = createMediaRewriter({ origin: ORIGIN, key, cache }).rewrite(stored) as typeof post;
    expect(stored).toEqual(post);
    expect(out.imageUrl).not.toBe(SOURCE);
  });
});

describe('feed article body rewrite', () => {
  const IMAGE = 'https://images.example/chart.png';
  const article = (body: string) => ({
    id: 'feed-qa',
    agentId: 'agent-qa',
    title: 'Article',
    summary: 'Summary',
    body,
    liked: false,
    createdAt: '2026-10-27T00:00:00Z',
    updatedAt: '2026-10-27T00:00:00Z',
  });

  async function spyingRewriter() {
    const { cache } = await setup(respondWith(PNG));
    const warmed: string[] = [];
    const spied: MediaCache = { get: (url) => cache.get(url), warm: (url) => { warmed.push(url); cache.warm(url); } };
    return { rewriter: createMediaRewriter({ origin: ORIGIN, key, cache: spied }), warmed };
  }

  it('signs a body-only inline picture, warms the cache, and keeps prose and source links', () => {
    return spyingRewriter().then(({ rewriter, warmed }) => {
      const body = 'Before.\n\n![Chart](' + IMAGE + ')\n\nCaption. [Source](https://news.example/story)\n\nAfter.';
      const input = article(body);
      const output = rewriter.rewriteJson(JSON.stringify(input));
      expect(output.includes(signedMediaUrl(ORIGIN, IMAGE, key))).toBe(true);
      expect(warmed).toEqual([IMAGE]);
      expect(input.body).toBe(body);
      expect(output.includes('[Source](https://news.example/story)')).toBe(true);
      expect(output.includes('Before.')).toBe(true);
    });
  });

  it('signs reference images once no matter how often they are referenced', () => {
    return spyingRewriter().then(({ rewriter, warmed }) => {
      const other = 'https://images.example/photo.png';
      const body = ['Intro.', '', '![One][a] and ![Two][] and ![A].', '', '[a]: ' + IMAGE, '[two]: ' + other + ' "Titled"', ''].join('\n');
      const parsed = rewriter.rewrite(article(body)) as { body: string };
      const signed = signedMediaUrl(ORIGIN, IMAGE, key);
      expect(parsed.body.includes(signed)).toBe(true);
      expect(parsed.body.includes(signedMediaUrl(ORIGIN, other, key))).toBe(true);
      expect(parsed.body.includes(IMAGE)).toBe(false);
      // Replacements splice back to front, so warming follows definition order.
      expect(warmed).toEqual([other, IMAGE]);
    });
  });

  it('leaves fenced and inline code pictures alone while signing the rendered one', () => {
    return spyingRewriter().then(({ rewriter, warmed }) => {
      const fenced = 'https://evil.example/fenced.png';
      const inline = 'https://evil.example/inline.png';
      const body = ['Text.', '', '```', '![' + 'x](' + fenced + ')', '```', '', 'Code `![' + 'y](' + inline + ')` here.', '', '![Real](' + IMAGE + ').'].join('\n');
      const parsed = rewriter.rewrite(article(body)) as { body: string };
      expect(parsed.body.includes(fenced)).toBe(true);
      expect(parsed.body.includes(inline)).toBe(true);
      expect(parsed.body.includes(signedMediaUrl(ORIGIN, IMAGE, key))).toBe(true);
      expect(warmed).toEqual([IMAGE]);
    });
  });

  it('leaves ordinary unrelated text unsigned: drafts, title-only cards and http URLs', () => {
    return spyingRewriter().then(({ rewriter, warmed }) => {
      const draft = { draft: { subject: 'Hi', body: 'See ![x](' + IMAGE + ')' } };
      const ref = { type: 'feed_ref', agentId: 'agent-qa', feedPostId: 'p1', title: 'T', summary: 'S' };
      const untitled = { body: 'Look ![x](' + IMAGE + ')' };
      const httpArticle = article('See ![x](http://cdn.example.com/pic.png)');
      expect(rewriter.rewrite(draft)).toEqual(draft);
      expect(rewriter.rewrite(ref)).toEqual(ref);
      expect(rewriter.rewrite(untitled)).toEqual(untitled);
      const httpOut = rewriter.rewrite(httpArticle) as { body: string };
      expect(httpOut.body.includes('http://cdn.example.com/pic.png')).toBe(true);
      expect(warmed).toEqual([]);
    });
  });

  it('keeps own-origin body URLs as they are, so rewriting is idempotent', () => {
    return spyingRewriter().then(({ rewriter, warmed }) => {
      const own = ORIGIN + '/v1/library/x/download';
      const body = '![Own](' + own + ') and ![Ext](' + IMAGE + ')';
      const once = rewriter.rewrite(article(body)) as { body: string };
      expect(once.body.includes('![Own](' + own + ')')).toBe(true);
      const twice = rewriter.rewriteJson(JSON.stringify({ ...article(body), body: once.body }));
      expect(twice.includes(signedMediaUrl(ORIGIN, IMAGE, key))).toBe(true);
      expect(warmed).toEqual([IMAGE]);
    });
  });

  it('signs cover and body pictures through the JSON list, served back from the media cache', async () => {
    const cover = 'https://cdn.example.com/cover.jpg';
    const { cache, request } = await setup(respondWith(PNG));
    const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: (async () => Response.json({ items: [{ ...article('Read. ![Chart](' + IMAGE + ') done.'), imageUrl: cover }] })) as typeof fetch, media: { key, cache, origin: ORIGIN } });
    const listed = (await (await app.request('/v1/feed')).json()) as { items: Array<{ imageUrl: string; body: string }> };
    expect(listed.items[0]!.imageUrl).toBe(signedMediaUrl(ORIGIN, cover, key));
    expect(listed.items[0]!.body.includes(signedMediaUrl(ORIGIN, IMAGE, key))).toBe(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    const served = await app.request(new URL(listed.items[0]!.body.match(/https?:\/\/[^)]+/)?.[0] ?? '', ORIGIN).pathname);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
  });

  it('signs feed event post bodies across SSE chunk boundaries and keeps framing', async () => {
    const lines = [`event: feed.created\ndata: ${JSON.stringify({ type: 'feed.created', post: article('New. ![Chart](' + IMAGE + ')') })}\n\n`, `event: feed.updated\ndata: ${JSON.stringify({ type: 'feed.updated', post: article('Fix. ![Chart](' + IMAGE + ')') })}\n\n`].join('');
    const half = Math.floor(lines.length / 2);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(lines.slice(0, half))); c.enqueue(encoder.encode(lines.slice(half))); c.close(); } });
    const { app } = await gateway(() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    const text = await (await app.request('/v1/events')).text();
    expect(text.includes(signedMediaUrl(ORIGIN, IMAGE, key))).toBe(true);
    expect(text.includes('"imageUrl":"' + IMAGE)).toBe(false);
    expect(text.includes(IMAGE)).toBe(false);
    expect(text.startsWith('event: feed.created\n')).toBe(true);
});
});

describe('loopback media origin rebase', () => {
  const LOOPBACK = 'http://127.0.0.1:8787';
  const PHONE = 'https://phone.example';
  const IMAGE = 'https://images.example/chart.png';
  const post = { id: 'p1', agentId: 'a1', title: 'T', summary: 'S', body: 'See ![C](' + IMAGE + ')', imageUrl: IMAGE, liked: false };

  async function loopbackApp() {
    const { cache } = await setup(respondWith(PNG));
    return createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: (async () => Response.json({ items: [post] })) as typeof fetch, media: { key, cache, origin: LOOPBACK } });
  }

  it('signs onto the incoming request origin when the configured origin is loopback', async () => {
    const { cache } = await setup(respondWith(PNG));
    const rewriter = createMediaRewriter({ origin: LOOPBACK, key, cache });
    const rebased = rewriter.rewriteJson(JSON.stringify(post), PHONE + '/v1/feed');
    expect(rebased.includes(signedMediaUrl(PHONE, IMAGE, key))).toBe(true);
    expect(rebased.includes(LOOPBACK + '/v1/media/')).toBe(false);
    const stable = rewriter.rewriteJson(JSON.stringify(post));
    expect(stable.includes(signedMediaUrl(LOOPBACK, IMAGE, key))).toBe(true);
  });

  it('keeps an explicitly configured public origin authoritative for remote requests', async () => {
    const { cache } = await setup(respondWith(PNG));
    const rewriter = createMediaRewriter({ origin: 'https://juno.example', key, cache });
    const output = rewriter.rewriteJson(JSON.stringify(post), PHONE + '/v1/feed');
    expect(output.includes(signedMediaUrl('https://juno.example', IMAGE, key))).toBe(true);
    expect(output.includes(PHONE + '/v1/media/')).toBe(false);
  });

  it('rebases cover and body URLs through the JSON list for a remote phone, keeping source links', async () => {
    const app = await loopbackApp();
    const json = await (await app.request(PHONE + '/v1/feed')).text();
    expect(json.includes(PHONE + '/v1/media/')).toBe(true);
    expect(json.includes(LOOPBACK + '/v1/media/')).toBe(false);
    expect(json.includes(IMAGE)).toBe(false);
  });

  it('rebases SSE event post bodies for a remote phone', async () => {
    const { cache } = await setup(respondWith(PNG));
    const line = `data: ${JSON.stringify({ type: 'feed.created', post })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(line)); c.close(); } });
    const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: (async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch, media: { key, cache, origin: LOOPBACK } });
    const text = await (await app.request(PHONE + '/v1/events')).text();
    expect(text.includes(PHONE + '/v1/media/')).toBe(true);
    expect(text.includes(LOOPBACK + '/v1/media/')).toBe(false);
  });

  it('ignores malicious forwarded headers and keeps loopback URLs for loopback requests', async () => {
    const app = await loopbackApp();
    const forged = await (await app.request(LOOPBACK + '/v1/feed', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } })).text();
    expect(forged.includes('evil.example')).toBe(false);
    expect(forged.includes(LOOPBACK + '/v1/media/')).toBe(true);
  });
});

describe('origin rebase review regressions', () => {
  const LOOPBACK = 'http://127.0.0.1:8787';
  const PHONE = 'https://phone.example';
  const IMAGE = 'https://images.example/chart.png';
  const post = { id: 'p1', agentId: 'a1', title: 'T', summary: 'S', body: 'See ![C](' + IMAGE + ')', imageUrl: IMAGE, liked: false };

  it('treats a public 127-prefixed domain as authoritative, never loopback', async () => {
    const { cache } = await setup(respondWith(PNG));
    const rewriter = createMediaRewriter({ origin: 'https://127.example.com', key, cache });
    const output = rewriter.rewriteJson(JSON.stringify(post), PHONE + '/v1/feed');
    expect(output.includes(signedMediaUrl('https://127.example.com', IMAGE, key))).toBe(true);
    expect(output.includes(PHONE + '/v1/media/')).toBe(false);
  });

  it('never proxies an already-rebased remote media URL twice', async () => {
    const { cache } = await setup(respondWith(PNG));
    const warmed: string[] = [];
    const spied: MediaCache = { get: (url) => cache.get(url), warm: (url) => { warmed.push(url); cache.warm(url); } };
    const rewriter = createMediaRewriter({ origin: LOOPBACK, key, cache: spied });
    const once = rewriter.rewriteJson(JSON.stringify(post), PHONE + '/v1/feed');
    expect(once.includes(PHONE + '/v1/media/')).toBe(true);
    warmed.length = 0;
    const twice = rewriter.rewriteJson(once, PHONE + '/v1/feed');
    expect(twice).toBe(once);
    expect(warmed).toEqual([]);
  });
});

describe('edge TLS scheme', () => {
  const LOOPBACK = 'http://127.0.0.1:8787';
  const IMAGE = 'https://images.example/chart.png';
  const COVER = 'https://cdn.example.com/cover.jpg';
  const article = (body: string) => ({
    id: 'feed-edge',
    agentId: 'agent-qa',
    title: 'Article',
    summary: 'Summary',
    body,
    imageUrl: COVER,
    liked: false,
  });

  it('signs cover and body with the edge https scheme behind a TLS-terminating edge', async () => {
    const { cache } = await setup(respondWith(PNG));
    const rewriter = createMediaRewriter({ origin: LOOPBACK, edgeScheme: 'https', key, cache });
    const out = rewriter.rewrite(article('See ![C](' + IMAGE + ')'), 'http://phone.example/v1/feed') as { imageUrl: string; body: string };
    expect(out.imageUrl).toBe(signedMediaUrl('https://phone.example', COVER, key));
    expect(out.body.includes(signedMediaUrl('https://phone.example', IMAGE, key))).toBe(true);
    expect(out.body.includes('http://phone.example/v1/media/')).toBe(false);
  });

  it('upgrades a public http origin to the edge scheme with no request origin', async () => {
    const { cache } = await setup(respondWith(PNG));
    const rewriter = createMediaRewriter({ origin: 'http://api.example', edgeScheme: 'https', key, cache });
    const out = rewriter.rewrite(article('See ![C](' + IMAGE + ')')) as { imageUrl: string; body: string };
    expect(out.imageUrl).toBe(signedMediaUrl('https://api.example', COVER, key));
    expect(out.body.includes(signedMediaUrl('https://api.example', IMAGE, key))).toBe(true);
  });

  it('preserves local-dev http signing when the edge scheme is absent', async () => {
    const { cache } = await setup(respondWith(PNG));
    const rewriter = createMediaRewriter({ origin: LOOPBACK, key, cache });
    const out = rewriter.rewrite(article('See ![C](' + IMAGE + ')'), 'http://phone.example/v1/feed') as { imageUrl: string; body: string };
    expect(out.imageUrl).toBe(signedMediaUrl('http://phone.example', COVER, key));
    expect(out.body.includes('https://phone.example/v1/media/')).toBe(false);
  });

  it('keeps a loopback dev config on plain HTTP for local requests even with the edge scheme set', async () => {
    const { cache } = await setup(respondWith(PNG));
    const rewriter = createMediaRewriter({ origin: LOOPBACK, edgeScheme: 'https', key, cache });
    const local = rewriter.rewrite(article('See ![C](' + IMAGE + ')'), LOOPBACK + '/v1/feed') as { imageUrl: string; body: string };
    expect(local.imageUrl).toBe(signedMediaUrl(LOOPBACK, COVER, key));
    expect(local.body.includes(signedMediaUrl(LOOPBACK, IMAGE, key))).toBe(true);
    const noIncoming = rewriter.rewrite(article('See ![C](' + IMAGE + ')')) as { imageUrl: string };
    expect(noIncoming.imageUrl).toBe(signedMediaUrl(LOOPBACK, COVER, key));
  });

  it('keeps edge-signed URLs idempotent', async () => {
    const { cache } = await setup(respondWith(PNG));
    const warmed: string[] = [];
    const spied: MediaCache = { get: (url) => cache.get(url), warm: (url) => { warmed.push(url); cache.warm(url); } };
    const rewriter = createMediaRewriter({ origin: LOOPBACK, edgeScheme: 'https', key, cache: spied });
    const once = rewriter.rewriteJson(JSON.stringify(article('See ![C](' + IMAGE + ')')), 'http://phone.example/v1/feed');
    expect(once.includes('https://phone.example/v1/media/')).toBe(true);
    warmed.length = 0;
    const twice = rewriter.rewriteJson(once, 'http://phone.example/v1/feed');
    expect(twice).toBe(once);
    expect(warmed).toEqual([]);
  });

  it('serves edge https cover and body URLs through the JSON list and SSE', async () => {
    const { cache } = await setup(respondWith(PNG));
    const fetchUpstream = (async () => Response.json({ items: [article('Read. ![Chart](' + IMAGE + ') done.')] })) as typeof fetch;
    const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: fetchUpstream, media: { key, cache, origin: LOOPBACK, edgeScheme: 'https' } });
    const json = await (await app.request('http://phone.example/v1/feed')).text();
    expect(json.includes('https://phone.example/v1/media/')).toBe(true);
    expect(json.includes('http://phone.example/v1/media/')).toBe(false);
    expect(json.includes(IMAGE)).toBe(false);
    const line = `data: ${JSON.stringify({ type: 'feed.created', post: article('New. ![Chart](' + IMAGE + ')') })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(line)); c.close(); } });
    const events = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: (async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch, media: { key, cache, origin: LOOPBACK, edgeScheme: 'https' } });
    const text = await (await events.request('http://phone.example/v1/events')).text();
    expect(text.includes('https://phone.example/v1/media/')).toBe(true);
    expect(text.includes(IMAGE)).toBe(false);
  });

  it('ignores forged forwarded headers; the explicit edge scheme wins', async () => {
    const { cache } = await setup(respondWith(PNG));
    const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: (async () => Response.json({ items: [article('See ![C](' + IMAGE + ')')] })) as typeof fetch, media: { key, cache, origin: LOOPBACK, edgeScheme: 'https' } });
    const forged = await (await app.request(LOOPBACK + '/v1/feed', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } })).text();
    expect(forged.includes('evil.example')).toBe(false);
    expect(forged.includes('http://127.0.0.1:8787/v1/media/')).toBe(true);
    expect(forged.includes('https://127.0.0.1:8787/v1/media/')).toBe(false);
  });
});
