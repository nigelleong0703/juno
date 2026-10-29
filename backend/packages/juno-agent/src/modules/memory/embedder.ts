/**
 * Text to vectors for the memory index (BACKEND §5.2): a hosted OpenAI-compatible `/embeddings` endpoint.
 *
 * Configured by EMBEDDING_BASE_URL (for example https://api.jina.ai/v1), EMBEDDING_API_KEY and EMBEDDING_MODEL, plus an optional
 * EMBEDDING_DIMENSIONS (sent as `dimensions` only when set). Without base URL, key and model there is no embedder and memory is
 * searched by keywords alone; so it is when a call fails (one warning, then calls are skipped for a minute). Tests inject a fake.
 */
export interface Embedder {
  /** The model name stored with every vector; a vector from another model is ignored and re-embedded. */
  model: string;
  /** The `dimensions` asked for, when configured; a stored vector of another length is ignored and re-embedded. */
  dimensions?: number;
  /** One vector per text, or null when the service is unavailable (callers then rank by keywords alone). */
  embed(texts: readonly string[]): Promise<number[][] | null>;
}

export interface EmbedderOptions {
  fetch?: typeof fetch;
  log?: (fields: Record<string, unknown>, message: string) => void;
  now?: () => number;
  /** Wait before the single retry. */
  retryDelayMs?: number;
}

/** Texts per request, requests in flight at once, and the time one request may take. */
export const EMBED_BATCH = 32;
const CONCURRENCY = 3;
const TIMEOUT_MS = 20_000;
/** After a failed call the service is left alone this long, so an outage does not slow every search. */
const COOLDOWN_MS = 60_000;

export function createEmbedder(env: NodeJS.ProcessEnv = process.env, options: EmbedderOptions = {}): Embedder | undefined {
  const base = env['EMBEDDING_BASE_URL']?.trim() ?? '';
  const key = env['EMBEDDING_API_KEY']?.trim() ?? '';
  const model = env['EMBEDDING_MODEL']?.trim() ?? '';
  if (base.length === 0 || key.length === 0 || model.length === 0) {
    options.log?.({}, 'EMBEDDING_BASE_URL, EMBEDDING_API_KEY and EMBEDDING_MODEL are not all set; memory is searched by keywords only');
    return undefined;
  }
  const dimensions = Number.parseInt(env['EMBEDDING_DIMENSIONS']?.trim() ?? '', 10);
  const dims = Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const url = base.replace(/\/+$/, '') + '/embeddings';
  let failedAt: number | undefined;
  let warned = false;

  async function request(texts: readonly string[]): Promise<number[][]> {
    const body = JSON.stringify({ model, input: texts, encoding_format: 'float', ...(dims === undefined ? {} : { dimensions: dims }) });
    for (let attempt = 0; ; attempt += 1) {
      let retryable = true;
      try {
        const response = await fetchFn(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (response.ok) return parse(await response.json(), texts.length);
        retryable = response.status === 429 || response.status >= 500;
        throw new Error(`embeddings request failed with HTTP ${response.status}`);
      } catch (error) {
        if (attempt >= 1 || !retryable) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return {
    model,
    ...(dims === undefined ? {} : { dimensions: dims }),
    async embed(texts) {
      if (texts.length === 0) return [];
      if (failedAt !== undefined && now() - failedAt < COOLDOWN_MS) return null;
      const batches: Array<readonly string[]> = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) batches.push(texts.slice(i, i + EMBED_BATCH));
      const results: number[][][] = [];
      try {
        for (let i = 0; i < batches.length; i += CONCURRENCY) {
          results.push(...await Promise.all(batches.slice(i, i + CONCURRENCY).map(request)));
        }
      } catch (error) {
        failedAt = now();
        if (!warned) options.log?.({ err: error instanceof Error ? error.message : String(error) }, 'memory embedding failed; memory is searched by keywords until the service answers');
        warned = true;
        return null;
      }
      failedAt = undefined;
      warned = false;
      return results.flat();
    },
  };
}

/** The vectors of an OpenAI-style response in input order (`data[].index`); anything else is an error. */
function parse(body: unknown, expected: number): number[][] {
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || data.length !== expected) throw new Error('embeddings response does not match the request');
  const vectors: Array<number[] | undefined> = new Array<number[] | undefined>(expected).fill(undefined);
  data.forEach((item: unknown, position) => {
    const { index, embedding } = (item ?? {}) as { index?: unknown; embedding?: unknown };
    const slot = typeof index === 'number' ? index : position;
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((x) => typeof x === 'number') || slot < 0 || slot >= expected) {
      throw new Error('embeddings response has a malformed vector');
    }
    vectors[slot] = embedding as number[];
  });
  if (vectors.some((v) => v === undefined)) throw new Error('embeddings response is missing a vector');
  return vectors as number[][];
}
