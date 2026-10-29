/**
 * Which models reach hidden tools through the provider's own tool search: the catalog says so (ChatGPT sign-in, gpt-5.4+), or the model
 * was verified live and is listed; every other model (and every other wire) keeps the tool_call proxy.
 */
import { describe, expect, it } from 'vitest';
import { findBuiltinModel } from '../builtin-providers.js';
import { resolveToolSearchMode } from '../tool-search-mode.js';

function modeOf(provider: string, id: string) {
  const model = findBuiltinModel(provider, id);
  if (model === undefined) throw new Error('the catalog has no ' + provider + '/' + id);
  return resolveToolSearchMode(model);
}

describe('resolveToolSearchMode over the real catalog', () => {
  it('uses the native search where the catalog says the model supports it', () => {
    expect(modeOf('openai', 'gpt-5.4')).toBe('responses-tool-search');
    expect(modeOf('openai', 'gpt-5.6-luna')).toBe('responses-tool-search');
  });

  it('uses it for the models verified live on the opencode-go gateway', () => {
    expect(modeOf('opencode-go', 'muse-spark-1.3-contributor')).toBe('responses-tool-search');
    expect(modeOf('opencode-go', 'gpt-5.6-luna')).toBe('responses-tool-search');
  });

  it('keeps everything else on the proxy: unverified Responses models, other wires, other providers', () => {
    expect(modeOf('opencode-go', 'muse-spark-1.2-contributor')).toBe('proxy');
    expect(modeOf('opencode-go', 'grok-4.6')).toBe('proxy');
    expect(modeOf('opencode', 'gpt-5.4')).toBe('proxy');
    expect(modeOf('github-copilot', 'gpt-5.4')).toBe('proxy');
    expect(modeOf('anthropic', 'claude-sonnet-5-5')).toBe('proxy');
    expect(modeOf('opencode-go', 'qwen3.8-flash')).toBe('proxy');
  });

  it('judges the platform default by the model id it is configured with', () => {
    const env = (id: string) => resolveToolSearchMode({ api: 'openai-responses', provider: 'openai', id });
    expect(env('opencode-go/muse-spark-1.3-contributor')).toBe('responses-tool-search');
    expect(env('muse-spark-1.3-contributor')).toBe('proxy');
    expect(resolveToolSearchMode({ api: 'openai-completions', provider: 'openai', id: 'opencode-go/muse-spark-1.3-contributor' })).toBe('proxy');
  });
});
