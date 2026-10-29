import { describe, expect, it } from 'vitest';
import type { Tool } from '../../../contracts/index.js';
import { requestCacheShape, cacheReadMetrics } from '../request-cache.js';
import { systemMessage } from '../context-notes.js';

const tool: Tool = { name: 'browser.click', description: 'Click an observed control', parameters: { type: 'object' },
  sideEffect: true, replay: 'never', execute: async () => ({ content: [] }) };

describe('cache observation', () => {
  it('tracks schema/system changes without hashing growing conversation suffixes or logging contents', () => {
    const initial = requestCacheShape([systemMessage('private context', 'profile', [])], [tool]);
    const later = requestCacheShape([systemMessage('private context', 'profile', []), { role: 'user', content: 'private follow-up', timestamp: 10 }], [tool]);
    expect(later).toEqual(initial);
    expect(requestCacheShape([systemMessage('changed context', 'profile', [])], [tool]).systemPromptHash).not.toBe(initial.systemPromptHash);
    expect(requestCacheShape([], [{ ...tool, parameters: { type: 'object', required: ['ref'] } }]).toolSchemaHash).not.toBe(initial.toolSchemaHash);
    expect(JSON.stringify(initial)).not.toContain('private');
  });

  it('counts all input once, includes cache writes, and distinguishes unknown usage', () => {
    const usage = { inputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10, outputTokens: 5, costUsd: 0, measured: true };
    expect(cacheReadMetrics(usage)).toEqual({ cacheUsageKnown: true, totalInputTokens: 100, cacheReadFraction: 0.7 });
    expect(cacheReadMetrics({ ...usage, measured: false })).toEqual({ cacheUsageKnown: false });
    expect(cacheReadMetrics({ ...usage, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toEqual({ cacheUsageKnown: true, totalInputTokens: 0 });
  });
});
