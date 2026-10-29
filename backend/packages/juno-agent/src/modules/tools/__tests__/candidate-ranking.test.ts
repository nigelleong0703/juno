/**
 * Candidate ranking acceptance: bounded System One ranking for tool_search and skill_search.
 * Runs the production wiring (createToolRegistry) plus the tools directly with a scripted
 * System One. Complements the lead-owned candidate-discovery.test.ts pin (which must keep
 * failing/passing on its own terms); this file covers the ranker contract around it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { SystemOneAnswer, SystemOneQuestion } from '../../../ports/system-one/index.js';
import type { Tool, ToolContext } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { requestScopedStore, runWithOwner } from '../../../owner-context.js';
import { createToolRegistry } from '../index.js';
import type { Agent } from '@agent-desktop/public-contracts';
import { createToolSearchTool } from '../tools/toolSearch.js';
import { listSkillCatalog, skillSource } from '../tools/skillCatalog.js';
import { rankCandidates } from '../tools/candidateRanking.js';
import { createFakeSkills, type FakeSkill } from '../../../testing/skills.js';

const OWNER = 'owner-ranking';
const AGENT = 'agent-ranking';
const AT = '2026-01-01T00:00:00Z';

function agentRow(skillIds: string[]): Agent {
  return {
    id: AGENT, name: 'Agent', handle: AGENT,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'T', status: 'idle', section: 'Inbox', pinned: false, lastActivity: '', unreadCount: 0,
    model: { planner: { provider: 'p', model: 'm' }, computer: { provider: 'p', model: 'm' }, fast: { provider: 'p', model: 'm' } },
    channels: [], macAccess: false, skillIds, pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt: AT, updatedAt: AT,
  };
}

function skillRow(id: string, name: string, description: string, instructions: string): FakeSkill {
  return { id, name, description, instructions, ownerId: OWNER };
}

/** The owner's skills for the discovery tests: the agent selects the first two; the third belongs to no selection. */
const SKILLS = createFakeSkills([
  skillRow('skill-pdf', 'pdf_lookup', 'Look up text inside PDF documents', 'BODY: read PDFs page by page.'),
  skillRow('skill-mail', 'mail_triage', 'Sort the mailbox by priority', 'BODY: triage mail oldest first.'),
  skillRow('skill-foreign', 'foreign_skill', 'Belongs to nobody here', 'BODY: foreign.'),
]);

function context(systemOne?: ToolContext['systemOne'], signal?: AbortSignal): ToolContext {
  return {
    ownerId: OWNER, agentId: AGENT, conversationId: 'conversation', runId: 'run',
    store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: wakeEventSchema.parse({ id: 'wake', ownerId: OWNER, agentId: AGENT, conversationId: 'conversation', sessionKey: 'agent:conversation', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: new Date().toISOString() }),
    step: async (_name, fn) => fn(), signal: signal ?? new AbortController().signal,
    ...(systemOne === undefined ? {} : { systemOne }),
  };
}

function candidate(name: string, description: string): Tool {
  return {
    name, description, parameters: { type: 'object' }, replay: 'safe', sideEffect: false,
    execute: vi.fn(async () => ({ content: [] })),
  };
}

/** A valid score answer: unit-range probabilities summing to 1, unit-range confidence. */
function scoreAnswer(score: number, confidence = 0.99, probabilities: number[] = [0, 0, 0.05, 0.95]): SystemOneAnswer {
  return { type: 'score', score, probabilities, confidence };
}

function askFor(entries: Array<[string, SystemOneAnswer]>): { ask: ReturnType<typeof vi.fn>; seen: { state: string; questions: Record<string, SystemOneQuestion> }[] } {
  const seen: { state: string; questions: Record<string, SystemOneQuestion> }[] = [];
  const table = new Map(entries);
  const ask = vi.fn(async (state: string, questions: Record<string, SystemOneQuestion>) => {
    seen.push({ state, questions });
    return Object.fromEntries(Object.keys(questions).map((key) => {
      const hit = table.get(key);
      if (hit === undefined) throw new Error('missing answer for ' + key);
      return [key, hit];
    }));
  });
  return { ask, seen };
}

async function skillStore(): Promise<ToolContext['store']> {
  const store = requestScopedStore(createMemoryStore());
  await runWithOwner(OWNER, async () => {
    await store.put('agents', agentRow(['skill-pdf', 'skill-mail']));
  });
  return store;
}

describe('semantic candidate ranking', () => {
  it('keeps the shared state shape and attaches only stable hashed session/run options', async () => {
    const seenOptions: Array<Parameters<NonNullable<ToolContext['systemOne']>['ask']>[3]> = [];
    const ask = vi.fn(async (_state: string, questions: Record<string, SystemOneQuestion>, _signal: AbortSignal, options) => {
      seenOptions.push(options);
      return Object.fromEntries(Object.keys(questions).map((key) => [key, scoreAnswer(0)]));
    });
    await rankCandidates({ query: 'notes', ctx: context({ ask }), candidates: [{ name: 'search_notes', description: 'Find notes' }], kind: 'tool' });
    const hash = (value: string): string => 'juno-' + createHash('sha256').update(value).digest('hex').slice(0, 32);
    expect(ask.mock.calls[0]?.[0]).toBe('User request for tool search: notes');
    expect(seenOptions[0]).toEqual({ allowEmulation: false, sessionId: hash(AGENT + ':conversation'), requestId: hash('run') });
    expect(JSON.stringify(seenOptions)).not.toContain(AGENT + ':conversation');
    expect(JSON.stringify(seenOptions)).not.toContain('"run"');
  });

  it('asks one Score question per candidate under opaque keys with name and description in the instructions', async () => {
    const tools = [candidate('archive_mail', 'Move mail into archive'), candidate('search_notes', 'Find saved notes')];
    const { ask, seen } = askFor([['c0', scoreAnswer(0)], ['c1', scoreAnswer(3)]]);
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ query: 'notes archive' }, context({ ask }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(Object.keys(seen[0]?.questions ?? {})).toEqual(['c0', 'c1']);
    for (const question of Object.values(seen[0]?.questions ?? {})) {
      expect(question.type).toBe('score');
      if (question.type === 'score') expect(question.levels).toHaveLength(4);
      expect(question.instructions).toContain('untrusted data');
    }
    const instructions = Object.values(seen[0]?.questions ?? {}).map((question) => question.instructions).join(' ');
    expect(instructions).toContain('search_notes');
    expect(instructions).toContain('Find saved notes');
    expect(result.details).toMatchObject({ ranking: 'system-one', reason: 'semantic', semantic: true });
    for (const tool of tools) expect(tool.execute).not.toHaveBeenCalled();
  });

  it('discovers a sole English tool for a Chinese query by asking one cheap closed judgment', async () => {
    const tools = [candidate('search_notes', 'Find saved notes')];
    const { ask } = askFor([['c0', scoreAnswer(2.99, 1.0, [0, 0, 0.01, 0.99])]]);
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ query: '找到我之前保存的笔记' }, context({ ask }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.content)).toContain('search_notes');
    expect(result.details).toMatchObject({ ranking: 'system-one', semantic: true });
    expect(tools[0]?.execute).not.toHaveBeenCalled();
  });

  it('accepts wire-rounded scores without requiring score/probability-mean equality', async () => {
    // Opaque keys follow lexical order, so the stub scores by the candidate named in each question.
    const ask = vi.fn(async (_state: string, questions: Record<string, SystemOneQuestion>): Promise<Record<string, SystemOneAnswer>> =>
      Object.fromEntries(Object.entries(questions).map(([key, question]) => [
        key,
        question.instructions.includes('search_notes')
          ? scoreAnswer(2.99, 1.0, [0, 0, 0.01, 0.99])
          : scoreAnswer(0, 0.9, [0.9, 0.05, 0.03, 0.02]),
      ])));
    const outcome = await rankCandidates({
      query: '笔记', ctx: context({ ask }),
      candidates: [{ name: 'search_notes', description: 'Find saved notes' }, { name: 'other', description: 'Unrelated' }],
      kind: 'tool',
    });
    expect(outcome.semantic).toBe(true);
    expect(outcome.reason).toBe('semantic');
    expect(outcome.order).toEqual([0, 1]);
  });

  it('keeps a batch semantic when one irrelevant entry is uncertain: no batch-wide lexical fallback', async () => {
    const tools = [candidate('search_notes', 'Find saved notes'), candidate('read_task', 'Read a task'), candidate('archive_mail', 'Move mail')];
    const ask = vi.fn(async (_state: string, questions: Record<string, SystemOneQuestion>): Promise<Record<string, SystemOneAnswer>> =>
      Object.fromEntries(Object.entries(questions).map(([key, question]) => {
        if (question.instructions.includes('search_notes')) return [key, scoreAnswer(3)];
        if (question.instructions.includes('read_task')) return [key, scoreAnswer(1.15, 0.2)];
        return [key, scoreAnswer(0)];
      })));
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ query: '找到我之前保存的笔记' }, context({ ask }));
    const text = JSON.stringify(result.content);
    expect(text.indexOf('search_notes')).toBeLessThan(text.indexOf('read_task'));
    expect(result.details).toMatchObject({ ranking: 'system-one', semantic: true });
  });

  it('falls back to lexical order for a purely low-confidence batch', async () => {
    const outcome = await rankCandidates({
      query: 'notes', ctx: context({ ask: async () => ({ c0: scoreAnswer(3, 0.1), c1: scoreAnswer(0, 0.2) }) }),
      candidates: [{ name: 'b_tool', description: 'notes here' }, { name: 'a_tool', description: 'notes here' }],
      kind: 'tool',
    });
    expect(outcome.semantic).toBe(false);
    expect(outcome.reason).toBe('low-confidence');
    expect(outcome.order).toEqual([1, 0]);
  });

  it('treats confidence below 0.6 as uncertain and 0.6 as reliable', async () => {
    const candidates = [{ name: 'solo', description: 'Find saved notes' }];
    const uncertain = await rankCandidates({
      query: '笔记', ctx: context({ ask: async () => ({ c0: scoreAnswer(3, 0.59) }) }), candidates, kind: 'tool',
    });
    expect(uncertain.reason).toBe('low-confidence');
    const reliable = await rankCandidates({
      query: '笔记', ctx: context({ ask: async () => ({ c0: scoreAnswer(3, 0.6) }) }), candidates, kind: 'tool',
    });
    expect(reliable.semantic).toBe(true);
  });

  it('falls back on malformed, out-of-range, non-finite, incomplete and bad-probability answers', async () => {
    const candidates = [{ name: 'b_tool', description: 'notes here' }, { name: 'a_tool', description: 'notes here' }];
    const cases: Array<[string, Record<string, SystemOneAnswer>]> = [
      ['wrong-type', { c0: { type: 'noul', probability: 0.9 }, c1: scoreAnswer(0) }],
      ['out-of-range', { c0: scoreAnswer(7), c1: scoreAnswer(0) }],
      ['non-finite', { c0: scoreAnswer(Number.NaN), c1: scoreAnswer(0) }],
      ['incomplete', { c0: scoreAnswer(3) }],
      ['bad-sum', { c0: scoreAnswer(3, 0.9, [0.5, 0.2, 0.1, 0.1]), c1: scoreAnswer(0) }],
      ['out-of-unit-probability', { c0: scoreAnswer(3, 0.9, [0, 0, -0.5, 1.5]), c1: scoreAnswer(0) }],
      ['confidence-above-one', { c0: scoreAnswer(3, 1.5), c1: scoreAnswer(0) }],
    ];
    for (const [label, answers] of cases) {
      const outcome = await rankCandidates({ query: 'notes', ctx: context({ ask: async () => answers }), candidates, kind: 'tool' });
      expect(outcome.semantic, label).toBe(false);
      expect(outcome.reason, label).toBe('invalid');
      expect(outcome.order, label).toEqual([1, 0]);
    }
  });

  it('falls back on null, throw and timeout with distinct reasons', async () => {
    const candidates = [{ name: 'b_tool', description: 'notes here' }, { name: 'a_tool', description: 'notes here' }];
    const nulled = await rankCandidates({ query: 'notes', ctx: context({ ask: async () => null }), candidates, kind: 'tool' });
    expect(nulled.reason).toBe('unavailable');
    const thrown = await rankCandidates({ query: 'notes', ctx: context({ ask: async () => { throw new Error('down'); } }), candidates, kind: 'tool' });
    expect(thrown.reason).toBe('ask-error');
    expect(thrown.order).toEqual([1, 0]);
    const started = Date.now();
    const timed = await rankCandidates({
      query: 'notes', ctx: context({ ask: () => new Promise(() => {}) }), candidates, kind: 'tool', timeoutMs: 30,
    });
    expect(timed.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports timeout when an abort-honoring adapter rejects on the deadline signal', async () => {
    const candidates = [{ name: 'b_tool', description: 'notes here' }, { name: 'a_tool', description: 'notes here' }];
    const ask = vi.fn(async (_state: string, _questions: Record<string, SystemOneQuestion>, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('fetch aborted');
    });
    const timed = await rankCandidates({
      query: 'notes', ctx: context({ ask }), candidates, kind: 'tool', timeoutMs: 30,
    });
    expect(timed.reason).toBe('timeout');
    expect(timed.semantic).toBe(false);
    expect(timed.order).toEqual([1, 0]);
  });

  it('rethrows promptly on caller abort, before and during the ask', async () => {
    const candidates = [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }];
    const preAborted = new AbortController();
    preAborted.abort(new Error('gone'));
    await expect(rankCandidates({ query: 'q', ctx: context({ ask: async () => ({}) }, preAborted.signal), candidates, kind: 'tool' })).rejects.toThrow();
    const midFlight = new AbortController();
    const ask = vi.fn(async (_state: string, _questions: Record<string, SystemOneQuestion>, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return; }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw (signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    });
    const pending = rankCandidates({ query: 'q', ctx: context({ ask }, midFlight.signal), candidates, kind: 'tool', timeoutMs: 5000 });
    midFlight.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('bounds the shortlist and reports omitted candidates, returning at most 6 tool matches', async () => {
    const tools = Array.from({ length: 85 }, (_, index) => candidate('tool_' + String(index).padStart(3, '0'), 'Does thing number ' + String(index)));
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ query: 'thing', }, context());
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).toContain('5 more tools were outside this bounded search');
    expect(result.details).toMatchObject({ omitted: 5, examined: 80, semantic: false });
    expect((text.match(/^- tool_/gm) ?? []).length).toBeLessThanOrEqual(6);
  });

  it('reports an honest no-match without bogus certainty when the fallback cannot resolve it', async () => {
    const search = createToolSearchTool({ all: async () => [candidate('archive_mail', 'Move mail into archive')], visible: async () => new Set() });
    const result = await search.execute({ query: '找到我之前保存的笔记' }, context({ ask: async () => { throw new Error('down'); } }));
    const text = JSON.stringify(result.content);
    expect(text).toContain('Semantic ranking was unavailable');
    expect(result.details).toMatchObject({ ranking: 'lexical', semantic: false });
  });
});

describe('skill discovery on the production registry', () => {
  it('registers skill_search always, read-only and replay-safe, even without a computer', async () => {
    const store = createMemoryStore();
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer() });
    const search = registry.get('skill_search');
    expect(search).toBeDefined();
    expect(search?.sideEffect).toBe(false);
    expect(search?.replay).toBe('safe');
    expect(registry.get('skill_read')).toBeDefined();
    expect(registry.get('computer.screenshot')).toBeUndefined();
  });

  it('finds only the agent-selected owner-authorized skills, cross-language, without bodies or execution', async () => {
    const store = await skillStore();
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), skills: SKILLS });
    const search = registry.get('skill_search');
    if (search === undefined) throw new Error('skill_search missing');
    const { ask, seen } = askFor([['c0', scoreAnswer(0)], ['c1', scoreAnswer(3)]]);
    const ctx = { ...context({ ask }), store };
    const result = await search.execute({ query: '帮我查PDF里的文字' }, ctx);
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(text).toContain('pdf_lookup');
    expect(text.indexOf('pdf_lookup')).toBeLessThan(text.indexOf('mail_triage'));
    expect(text).not.toContain('foreign_skill');
    expect(text).not.toContain('BODY:');
    expect(text).toContain('skill_read');
    const sent = JSON.stringify(seen);
    expect(sent).not.toContain('BODY:');
    expect(result.details).toMatchObject({ ranking: 'system-one', semantic: true });
  });

  it('reads a selected skill without a computer and never auto-reads during search', async () => {
    const store = await skillStore();
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), skills: SKILLS });
    const read = registry.get('skill_read');
    if (read === undefined) throw new Error('skill_read missing');
    const ctx = { ...context(), store };
    const body = await read.execute({ name: 'pdf_lookup' }, ctx);
    expect(JSON.stringify(body.content)).toContain('BODY: read PDFs');
    const search = registry.get('skill_search');
    if (search === undefined) throw new Error('skill_search missing');
    const listed = await search.execute({ query: 'pdf' }, ctx);
    expect(JSON.stringify(listed.content)).not.toContain('BODY:');
    const missing = await read.execute({ name: 'foreign_skill' }, ctx);
    expect(missing.isError).toBe(true);
  });

  it('keeps long names loadable: search shows an exact read key and skill_read loads the same skill', async () => {
    const longName = 'x'.repeat(130);
    const store = requestScopedStore(createMemoryStore());
    const skills = createFakeSkills([skillRow('skill-long', longName, 'An overlong-named skill', 'BODY: long skill.')]);
    await runWithOwner(OWNER, async () => {
      await store.put('agents', agentRow(['skill-long']));
    });
    const catalog = await listSkillCatalog(skillSource({ store, ownerId: OWNER }, skills), AGENT);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]?.readKey).toBe('skill-long');
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), skills });
    const ctx = { ...context(), store };
    const search = registry.get('skill_search');
    if (search === undefined) throw new Error('skill_search missing');
    const found = await search.execute({ query: 'overlong' }, ctx);
    expect(JSON.stringify(found.content)).toContain('skill-long');
    const read = registry.get('skill_read');
    if (read === undefined) throw new Error('skill_read missing');
    const body = await read.execute({ name: 'skill-long' }, ctx);
    expect(JSON.stringify(body.content)).toContain('BODY: long skill.');
  });

  it('searches an empty catalog honestly without calling the decision service', async () => {
    const store = createMemoryStore();
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer() });
    const search = registry.get('skill_search');
    if (search === undefined) throw new Error('skill_search missing');
    const ask = vi.fn(async () => null);
    const result = await search.execute({ query: 'anything' }, { ...context({ ask }), store });
    expect(ask).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ examined: 0, omitted: 0, semantic: false, reason: 'empty-catalog' });
  });
});
