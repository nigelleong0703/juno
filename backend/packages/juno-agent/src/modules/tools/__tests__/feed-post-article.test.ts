/** feed_post verifies every rendered body image before publishing anything. */
import { describe, expect, it } from 'vitest';
import type { Store, Tool, ToolContext } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { toolContext } from '../../../execution/brain/__tests__/agent-resources.fixtures.js';
import { createFeedPostTool } from '../tools/feedPost.js';
import type { SafeFetchDeps } from '../net/safeFetch.js';
import { fakeWeb, jpeg } from '../../feed/__tests__/image-fixtures.js';

const ownerStore = (): Store => {
  const forOwner = createMemoryStore().forOwner;
  if (forOwner === undefined) throw new Error('test store lacks forOwner');
  return forOwner('owner-1');
};

async function call(tool: Tool, ctx: ToolContext, args: unknown): Promise<{ text: string; isError: boolean }> {
  const result = await tool.execute(args, ctx);
  const part = result.content[0];
  return { text: part?.type === 'text' ? part.text : '', isError: result.isError === true };
}

const tall = (w: number, h: number): Buffer => jpeg(w, h);

describe('feed_post body images', () => {
  it('refuses an unavailable inline image with no partial writes', async () => {
    const store = ownerStore();
    const tool = createFeedPostTool({ deps: fakeWeb({}, { 'https://images.example/ok.jpg': jpeg(1200, 630) }) });
    const body = 'Before.\n\n![Missing](https://images.example/missing.jpg)\n\nAfter.';
    const res = await call(tool, toolContext(store, 'agent-a'), { title: 'Article', summary: 'Summary', body });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/nothing was published/);
    expect((await store.list('feedPosts')).items).toHaveLength(0);
    expect((await store.list('items', { where: { conversationId: 'conv-1' } })).items).toHaveLength(0);
  });

  it('publishes two verified images interleaved with prose, preserving body order', async () => {
    const store = ownerStore();
    const images = { 'https://images.example/one.jpg': jpeg(1200, 630), 'https://images.example/two.jpg': jpeg(900, 1200) };
    const tool = createFeedPostTool({ deps: fakeWeb({}, images) });
    const body = [
      'First section.',
      '',
      '![One](https://images.example/one.jpg)',
      '',
      'One caption. [Source](https://news.example/one)',
      '',
      'Second section.',
      '',
      '![Two](https://images.example/two.jpg)',
      '',
      'Two caption. [Source](https://news.example/two)',
    ].join('\n');
    const res = await call(tool, toolContext(store, 'agent-a'), { title: 'Article', summary: 'Summary', body });
    expect(res.isError).toBe(false);
    const posts = (await store.list('feedPosts')).items;
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toBe(body);
  });

  it('accepts a tall diagram the cover crop would reject, and still rejects logos', async () => {
    const store = ownerStore();
    const tool = createFeedPostTool({ deps: fakeWeb({}, { 'https://images.example/tall.jpg': tall(800, 2000) }) });
    const good = await call(tool, toolContext(store, 'agent-a'), {
      title: 'Article', summary: 'Summary', body: 'Intro.\n\n![Diagram](https://images.example/tall.jpg)',
    });
    expect(good.isError).toBe(false);
    const store2 = ownerStore();
    const tool2 = createFeedPostTool({ deps: fakeWeb({}, { 'https://images.example/site-logo.jpg': jpeg(1200, 630) }) });
    const bad = await call(tool2, toolContext(store2, 'agent-a'), {
      title: 'Article', summary: 'Summary', body: 'Intro.\n\n![Logo](https://images.example/site-logo.jpg)',
    });
    expect(bad.isError).toBe(true);
    expect((await store2.list('feedPosts')).items).toHaveLength(0);
  });

  it('refuses a body image that redirects off https to a private address', async () => {
    const store = ownerStore();
    const base = fakeWeb({}, {});
    let calls = 0;
    const deps: SafeFetchDeps = {
      ...base,
      request: async (hop, options) => {
        calls++;
        if (hop.url.href === 'https://images.example/redirect.jpg') {
          return { status: 301, headers: { location: 'http://127.0.0.1/private.jpg' }, body: Buffer.alloc(0), truncated: false };
        }
        return base.request?.(hop, options) ?? { status: 404, headers: {}, body: Buffer.alloc(0), truncated: false };
      },
    };
    const res = await call(createFeedPostTool({ deps }), toolContext(store, 'agent-a'), {
      title: 'Article', summary: 'Summary', body: 'Intro.\n\n![Redirect](https://images.example/redirect.jpg)',
    });
    expect(res.isError).toBe(true);
    expect(calls).toBeGreaterThan(0);
    expect((await store.list('feedPosts')).items).toHaveLength(0);
  });

  it('does not verify image-looking text inside fenced code or code spans', async () => {
    const store = ownerStore();
    const tool = createFeedPostTool({ deps: fakeWeb({}, {}) });
    const body = ['Example:', '', '```', '![No](https://unreachable.example/no.jpg)', '```', '', 'Inline `![No](https://unreachable.example/span.jpg)` done.'].join('\n');
    const res = await call(tool, toolContext(store, 'agent-a'), { title: 'Article', summary: 'Summary', body });
    expect(res.isError).toBe(false);
    expect((await store.list('feedPosts')).items).toHaveLength(1);
  });

  it('refuses an entity-encoded private host by its decoded address', async () => {
    const store = ownerStore();
    const tool = createFeedPostTool({ deps: fakeWeb({}, {}) });
    const res = await call(tool, toolContext(store, 'agent-a'), {
      title: 'Article', summary: 'Summary', body: 'Intro.\n\n![E](https://127&#46;0&#46;0&#46;1/x.jpg)',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('https://127.0.0.1/x.jpg');
    expect((await store.list('feedPosts')).items).toHaveLength(0);
  });

  it('downloads a URL shared by the cover and the body only once', async () => {
    const store = ownerStore();
    const base = fakeWeb({}, { 'https://images.example/shared.jpg': jpeg(1200, 630) });
    let calls = 0;
    const deps: SafeFetchDeps = {
      ...base,
      request: async (hop, options) => {
        calls++;
        return base.request?.(hop, options) ?? { status: 404, headers: {}, body: Buffer.alloc(0), truncated: false };
      },
    };
    const res = await call(createFeedPostTool({ deps }), toolContext(store, 'agent-a'), {
      title: 'Article',
      summary: 'Summary',
      body: 'Intro.\n\n![Shared](https://images.example/shared.jpg)',
      imageUrl: 'https://images.example/shared.jpg',
      imageCaption: 'The shared picture',
    });
    expect(res.isError).toBe(false);
    expect(calls).toBe(1);
  });

  it('stops verification on cancellation with nothing published', async () => {
    const store = ownerStore();
    const controller = new AbortController();
    controller.abort();
    const ctx = { ...toolContext(store, 'agent-a'), signal: controller.signal };
    const res = await call(createFeedPostTool({ deps: fakeWeb({}, { 'https://images.example/a.jpg': jpeg(1200, 630) }) }), ctx, {
      title: 'Article', summary: 'Summary', body: 'Intro.\n\n![A](https://images.example/a.jpg)',
    });
    expect(res.isError).toBe(true);
    expect((await store.list('feedPosts')).items).toHaveLength(0);
  });
});
