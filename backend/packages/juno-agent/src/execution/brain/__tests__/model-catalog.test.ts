import { describe, expect, it } from 'vitest';
import { createModelCatalogLoader, type ModelEnv } from '../model-catalog.js';

const ENV: ModelEnv = { modelId: 'qa-model', baseUrl: 'http://fixture.invalid/v1', apiKey: '', supportsImages: true };

function respond(document: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(document), { headers: { 'content-type': 'application/json' } });
}

describe('model catalog gateway shapes', () => {
  it('keeps a selected reasoning string distinct from the supported list', async () => {
    const loader = createModelCatalogLoader(ENV, respond({ data: [
      { id: 'qa-model', reasoning_effort: 'low', context_length: 872000, capabilities: { input_modalities: ['text', 'image'], output_modalities: ['text'], supports_tool_use: true, supports_reasoning: true, reasoning_effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] } },
      { id: 'qa-other', capabilities: { supports_tool_use: true } },
    ] }));
    const result = await loader.load();
    expect(result.fresh).toBe(true);
    expect(result.catalog.items.length).toBe(2);
    expect(result.catalog.items[0]?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('skips a malformed entry without discarding the catalog', async () => {
    const loader = createModelCatalogLoader(ENV, respond({ data: [
      { id: 7, capabilities: { supports_tool_use: true } },
      { id: 'qa-model', capabilities: { supports_tool_use: true } },
    ] }));
    const result = await loader.load();
    expect(result.fresh).toBe(true);
    expect(result.catalog.items.map((item) => item.id)).toEqual(['qa-model']);
  });
  it('gives a default model the gateway does not list its measured levels', async () => {
    const env: ModelEnv = { ...ENV, modelId: 'opencode-go/gpt-5.6-luna' };
    const loader = createModelCatalogLoader(env, respond({ data: [{ id: 'gpt-5.6-luna', capabilities: { supports_tool_use: true } }] }));
    const result = await loader.load();
    expect(result.catalog.items.find((item) => item.id === 'opencode-go/gpt-5.6-luna')).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], noReasoning: true });
  });
});
