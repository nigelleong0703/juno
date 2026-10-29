/**
 * The model-limits resolver reads the real context/output maximum from the configured model server
 * and must not pin a transient failure as the permanent answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { createModelLimitsSource } from '../model-limits.js';

const MODEL = 'opencode-go/deepseek-v4.1-flash';

const config = () =>
  loadConfig({ MODEL_BASE_URL: 'http://127.0.0.1:10100/v1', MODEL_API_KEY: 'test-key', MODEL_ID: MODEL });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createModelLimitsSource', () => {
  it('reads context and output limits, including nested fields, and caches the result', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: MODEL, context_window: 1048576, top_provider: { max_completion_tokens: 65536 } }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const source = createModelLimitsSource(config());

    expect(await source.getLimits()).toEqual({ contextWindow: 1048576, maxOutputTokens: 65536 });
    await source.getLimits();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads capabilities.context_length and max_output_tokens when present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: [{ id: MODEL, capabilities: { context_length: 200000 }, max_output_tokens: 8192 }] }),
          { status: 200 },
        ),
      ),
    );
    const source = createModelLimitsSource(config());
    expect(await source.getLimits()).toEqual({ contextWindow: 200000, maxOutputTokens: 8192 });
  });

  it('reports nothing rather than guessing when the model is absent or the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    expect(await createModelLimitsSource(config()).getLimits()).toEqual({});

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));
    expect(await createModelLimitsSource(config()).getLimits()).toEqual({});
  });

  it('retries a transient failure instead of caching the unknown answer forever', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: MODEL, context_length: 1000 }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = createModelLimitsSource(config());

    expect(await source.getLimits()).toEqual({});
    vi.setSystemTime(1_000_000 + 16_000);
    expect(await source.getLimits()).toEqual({ contextWindow: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
