/** The hosted embedder: request shape, batching, retry, failure and the config switch. The vectors of the memory items are in item-vectors.test.ts. */
import { describe, expect, it } from 'vitest';
import { createEmbedder, EMBED_BATCH } from '../embedder.js';

const ENV = { EMBEDDING_BASE_URL: 'https://embed.example/v1/', EMBEDDING_API_KEY: 'secret-key', EMBEDDING_MODEL: 'model-a' };

type Call = { url: string; headers: Record<string, string>; body: { model: string; input: string[]; dimensions?: number } };

/** A fetch that records requests and answers with `dim`-long vectors that point where the text says ("cat" -> x axis). */
function fakeFetch(statuses: number[] = [], dim = 3) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body) as Call['body'];
    calls.push({ url, headers: init.headers, body });
    const status = statuses.shift() ?? 200;
    if (status !== 200) return new Response('no', { status });
    const data = body.input.map((text, index) => ({ index, embedding: Array.from({ length: body.dimensions ?? dim }, (_, i) => (i === 0 ? (text.includes('cat') ? 1 : 0.1) : i === 1 ? (text.includes('nurse') ? 1 : 0.1) : 0.1)) }));
    return Response.json({ data: data.reverse() });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('hosted embedder', () => {
  it('posts an OpenAI-style request, sends dimensions only when set, and returns vectors in input order', async () => {
    const { fn, calls } = fakeFetch();
    const embedder = createEmbedder(ENV, { fetch: fn });
    expect(embedder?.model).toBe('model-a');
    expect(embedder?.dimensions).toBeUndefined();
    const vectors = await embedder?.embed(['a cat', 'a nurse']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://embed.example/v1/embeddings');
    expect(calls[0]?.headers['authorization']).toBe('Bearer secret-key');
    expect(calls[0]?.body).toEqual({ model: 'model-a', input: ['a cat', 'a nurse'], encoding_format: 'float' });
    expect(vectors?.[0]?.[0]).toBe(1);
    expect(vectors?.[1]?.[1]).toBe(1);

    const sized = fakeFetch(undefined, 8);
    const withDims = createEmbedder({ ...ENV, EMBEDDING_DIMENSIONS: '4' }, { fetch: sized.fn });
    expect(withDims?.dimensions).toBe(4);
    expect((await withDims?.embed(['x']))?.[0]).toHaveLength(4);
    expect(sized.calls[0]?.body.dimensions).toBe(4);
  });

  it('splits large inputs into batches', async () => {
    const { fn, calls } = fakeFetch();
    const texts = Array.from({ length: EMBED_BATCH * 2 + 5 }, (_, i) => 'text ' + String(i));
    const vectors = await createEmbedder(ENV, { fetch: fn })?.embed(texts);
    expect(calls.map((call) => call.body.input.length)).toEqual([EMBED_BATCH, EMBED_BATCH, 5]);
    expect(vectors).toHaveLength(texts.length);
  });

  it('retries once on 429/5xx, and does not retry a 4xx', async () => {
    const retried = fakeFetch([429]);
    expect(await createEmbedder(ENV, { fetch: retried.fn, retryDelayMs: 1 })?.embed(['x'])).not.toBeNull();
    expect(retried.calls).toHaveLength(2);
    const refused = fakeFetch([401]);
    expect(await createEmbedder(ENV, { fetch: refused.fn, retryDelayMs: 1 })?.embed(['x'])).toBeNull();
    expect(refused.calls).toHaveLength(1);
  });

  it('returns null on failure, warns once, and leaves the service alone for a minute', async () => {
    const logs: string[] = [];
    let clock = 0;
    const { fn, calls } = fakeFetch([500, 500, 500, 500]);
    const embedder = createEmbedder(ENV, { fetch: fn, retryDelayMs: 1, now: () => clock, log: (_f, message) => logs.push(message) });
    expect(await embedder?.embed(['x'])).toBeNull();
    expect(await embedder?.embed(['x'])).toBeNull();
    expect(calls).toHaveLength(2);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('secret-key');
    clock = 61_000;
    expect(await embedder?.embed(['x'])).toBeNull();
    expect(calls).toHaveLength(4);
    expect(logs).toHaveLength(1);
    clock = 200_000;
    expect(await embedder?.embed(['x'])).not.toBeNull();
  });

  it('is absent without config, with one warning', () => {
    const logs: string[] = [];
    expect(createEmbedder({ ...ENV, EMBEDDING_API_KEY: '' }, { log: (_f, message) => logs.push(message) })).toBeUndefined();
    expect(logs).toHaveLength(1);
  });
});
