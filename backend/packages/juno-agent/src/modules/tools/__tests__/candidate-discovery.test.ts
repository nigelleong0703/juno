import { describe, expect, it, vi } from 'vitest';
import type { Tool, ToolContext } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import type { SystemOneAnswers, SystemOneQuestion } from '../../../ports/system-one/index.js';
import { createToolRegistry } from '../index.js';
import { createToolSearchTool } from '../tools/toolSearch.js';

function context(): ToolContext {
  return {
    ownerId: 'owner', agentId: 'agent', conversationId: 'conversation', runId: 'run',
    store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: wakeEventSchema.parse({ id: 'wake', ownerId: 'owner', agentId: 'agent', conversationId: 'conversation', sessionKey: 'agent:conversation', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: new Date().toISOString() }),
    step: async (_name, fn) => fn(), signal: new AbortController().signal,
  };
}

function candidate(name: string, description: string): Tool {
  return { name, description, parameters: { type: 'object' }, replay: 'safe', sideEffect: false,
    execute: vi.fn(async () => ({ content: [] })),
  };
}

describe('candidate discovery acceptance', () => {
  it('finds an English tool for a Chinese query with no lexical overlap, without executing it', async () => {
    const tools = [candidate('archive_mail', 'Move mail into archive'), candidate('search_notes', 'Find saved notes')];
    const ask = vi.fn(async (_state: string, questions: Record<string, SystemOneQuestion>): Promise<SystemOneAnswers> =>
      Object.fromEntries(Object.entries(questions).map(([key, question]) => {
        const score = question.instructions.includes('search_notes') ? 3 : 0;
        return [key, { type: 'score', score, confidence: 0.99, probabilities: score === 3 ? [0, 0, 0, 1] : [1, 0, 0, 0] }];
      })));
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ query: '找到我之前保存的笔记' }, { ...context(), systemOne: { ask } });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.content).indexOf('search_notes')).toBeLessThan(JSON.stringify(result.content).indexOf('archive_mail'));
    expect(JSON.stringify(result.content)).toContain('search_notes');
    for (const tool of tools) expect(tool.execute).not.toHaveBeenCalled();
  });

  it('keeps lexical discovery working when the decision service fails', async () => {
    const search = createToolSearchTool({ all: async () => [candidate('search_notes', 'Find saved notes')], visible: async () => new Set() });
    const result = await search.execute({ query: 'notes' }, { ...context(), systemOne: { ask: async () => { throw new Error('unavailable'); } } });
    expect(JSON.stringify(result.content)).toContain('search_notes');
    expect(result.isError).not.toBe(true);
  });

  it('offers read-only skill discovery even when no computer is configured', async () => {
    const ctx = context();
    const registry = await createToolRegistry({ store: ctx.store, enqueuer: ctx.enqueuer });
    const search = registry.get('skill_search');
    expect(search).toBeDefined();
    expect(search?.sideEffect).toBe(false);
    expect(search?.replay).toBe('safe');
    expect(registry.get('computer.screenshot')).toBeUndefined();
  });
});
