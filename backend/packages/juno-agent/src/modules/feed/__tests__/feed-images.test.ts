/** The feed's technical picture gate (verifyFeedImage) and a page's own image candidates. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyFeedImage, pageImageUrls } from '../feedImage.js';
import { normalizeUrl } from '../context.js';
import { fakeWeb, jpeg, png, svg } from './image-fixtures.js';

const signal = new AbortController().signal;
const verify = (url: string, images: Record<string, Buffer>, seen?: { urls?: string[]; hashes?: string[] }) =>
  verifyFeedImage(url, { deps: fakeWeb({}, images), signal, normalize: normalizeUrl, seen: { urls: new Set(seen?.urls ?? []), hashes: new Set(seen?.hashes ?? []) } });

describe('verifyFeedImage', () => {
  it('accepts a large jpeg and a png of the right shape', async () => {
    expect(await verify('https://cdn.example/a.jpg', { 'https://cdn.example/a.jpg': jpeg(1200, 630) })).toMatchObject({ ok: true, url: 'https://cdn.example/a.jpg' });
    expect(await verify('https://cdn.example/b.png', { 'https://cdn.example/b.png': png(800, 800) })).toMatchObject({ ok: true });
  });

  it('rejects svg, small, odd-aspect and logo-named images', async () => {
    expect(await verify('https://cdn.example/a.svg', { 'https://cdn.example/a.svg': svg() })).toMatchObject({ ok: false });
    expect(await verify('https://cdn.example/a.jpg', { 'https://cdn.example/a.jpg': jpeg(400, 300) })).toMatchObject({ ok: false, reason: 'too small' });
    expect(await verify('https://cdn.example/a.jpg', { 'https://cdn.example/a.jpg': jpeg(1200, 200) })).toMatchObject({ ok: false, reason: 'odd aspect ratio' });
    expect(await verify('https://cdn.example/a.jpg', { 'https://cdn.example/a.jpg': jpeg(700, 1400) })).toMatchObject({ ok: false, reason: 'odd aspect ratio' });
    expect(await verify('https://cdn.example/assets/site-logo.jpg', { 'https://cdn.example/assets/site-logo.jpg': jpeg(1200, 630) })).toMatchObject({ ok: false });
    expect(await verify('https://cdn.example/img/default.jpg', { 'https://cdn.example/img/default.jpg': jpeg(1200, 630) })).toMatchObject({ ok: false });
  });

  it('rejects a duplicate by URL and by content', async () => {
    const bytes = jpeg(1200, 630);
    const images = { 'https://cdn.example/new.jpg': bytes };
    expect(await verify('https://cdn.example/new.jpg', images, { urls: [normalizeUrl('https://cdn.example/new.jpg')] })).toMatchObject({ ok: false, reason: 'image already used' });
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(await verify('https://cdn.example/new.jpg', images, { hashes: [hash] })).toMatchObject({ ok: false, reason: 'image already used' });
  });
});

describe('pageImageUrls', () => {
  it('reads og:image and JSON-LD images, skipping logo-looking ones', () => {
    const html = '<meta property="og:image" content="/logo.png"><meta name="twitter:image" content="https://cdn.example/t.jpg">'
      + '<script type="application/ld+json">{"@type":"NewsArticle","image":{"url":"https://cdn.example/ld.jpg"}}</script>';
    expect(pageImageUrls(html, 'https://news.example/a')).toEqual(['https://cdn.example/t.jpg', 'https://cdn.example/ld.jpg']);
  });
});
