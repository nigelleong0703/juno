/** web_fetch lets the model look at an image URL (as an image block) and lists a page's own images. */
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../contracts/index.js';
import { createWebFetchTool } from '../tools/webFetch.js';
import { fakeWeb, jpeg, svg } from '../../feed/__tests__/image-fixtures.js';

const ctx = (supportsImages?: boolean): ToolContext => ({ signal: new AbortController().signal, ...(supportsImages === undefined ? {} : { supportsImages }) }) as unknown as ToolContext;
const bytes = jpeg(1200, 630);
const web = fakeWeb(
  { 'https://news.example/a': '<html><head><title>Story</title><meta property="og:image" content="/lead.jpg"></head><body><p>Hello story</p></body></html>' },
  { 'https://news.example/lead.jpg': bytes },
);
const tool = createWebFetchTool({ deps: web });

describe('web_fetch on an image', () => {
  it('returns the picture as an image block when the model can see images', async () => {
    const result = await tool.execute({ url: 'https://news.example/lead.jpg' }, ctx(true));
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('image/jpeg 1200x630') });
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') });
  });

  it('says in text that it cannot be shown to a text-only model, without an image block', async () => {
    const result = await tool.execute({ url: 'https://news.example/lead.jpg' }, ctx(false));
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/cannot look at images/) });
  });

  it('refuses svg and anything that is not a raster picture', async () => {
    const svgWeb = { ...web, request: async () => ({ status: 200, headers: { 'content-type': 'image/svg+xml' }, body: svg(), truncated: false }) };
    const result = await createWebFetchTool({ deps: svgWeb }).execute({ url: 'https://news.example/logo.svg' }, ctx(true));
    expect(result.isError).toBe(true);
    expect(result.content.every((block) => block.type === 'text')).toBe(true);
  });
});

describe('web_fetch on a page', () => {
  it('lists the page\'s own image URLs after the text', async () => {
    const result = await tool.execute({ url: 'https://news.example/a' }, ctx(true));
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Hello story');
    expect(text).toMatch(/Images on this page[^]*- https:\/\/news\.example\/lead\.jpg/);
  });
});
