import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-desktop/public-contracts';
import { createFakeSkills, type FakeSkill } from '../../../testing/skills.js';
import { toolHashes, type SkillsService } from '@agent-desktop/memory-graph/skills';
import type { Tool, ToolContext } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import type { SystemOne, SystemOneAnswer, SystemOneQuestion } from '../../../ports/system-one/index.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { RankOutcome } from '../tools/candidateRanking.js';
import { clearDiscoveryMemo } from '../tools/discoveryMemo.js';
import { buildCandidatePool, MAX_PREPARE_NOTE_CHARS, renderRankedNote } from '../tools/prepare-render.js';
import { createToolPreparer } from '../tools/prepareTools.js';

const OWNER = 'owner-prepare';
const AGENT = 'agent-prepare';
const AT = '2026-01-01T00:00:00.000Z';

function agentRow(skillIds: string[]): Agent {
  return {
    id: AGENT,
    name: 'Preparer',
    handle: AGENT,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'Test agent',
    status: 'idle',
    section: 'Inbox',
    pinned: false,
    lastActivity: '',
    unreadCount: 0,
    model: {
      planner: { provider: 'p', model: 'm' },
      computer: { provider: 'p', model: 'm' },
      fast: { provider: 'p', model: 'm' },
    },
    channels: [],
    macAccess: false,
    skillIds,
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: OWNER,
    createdAt: AT,
    updatedAt: AT,
  };
}

function skillRow(id: string, name: string, description: string, instructions: string): FakeSkill {
  return { id, name, description, instructions, ownerId: OWNER };
}

function deferredTool(name: string, description: string, parameters: Record<string, unknown> = { type: 'object' }): Tool {
  return {
    name,
    description,
    parameters,
    replay: 'safe',
    sideEffect: false,
    deferLoading: true,
    execute: vi.fn(async () => ({ content: [] })),
  };
}

function mcpTool(
  name: string,
  connectionId: string,
  connectionName: string,
  account: string | undefined,
  description: string,
): Tool {
  return {
    name,
    description,
    parameters: { type: 'object' },
    replay: 'safe',
    sideEffect: false,
    mcp: true,
    origin: {
      connectionId,
      connectionName,
      toolName: name.slice(name.lastIndexOf('__') + 2),
      access: 'read',
      ...(account === undefined ? {} : { account }),
    },
    execute: vi.fn(async () => ({ content: [] })),
  };
}

function visibleTool(name: string): Tool {
  return {
    name,
    description: 'Already visible',
    parameters: { type: 'object' },
    replay: 'safe',
    sideEffect: false,
    deferLoading: false,
    execute: vi.fn(async () => ({ content: [] })),
  };
}

function ownedMemoryStore(): ToolContext['store'] {
  const store = createMemoryStore();
  if (store.forOwner === undefined) throw new Error('memory store does not support owner scopes');
  return store.forOwner(OWNER);
}

function context(
  store: ToolContext['store'] = ownedMemoryStore(),
  systemOne?: SystemOne,
  signal?: AbortSignal,
  agentId: string = AGENT,
  runId: string = 'run-prepare',
): ToolContext {
  return {
    ownerId: OWNER,
    agentId,
    conversationId: 'conversation-prepare',
    runId,
    store,
    blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    wake: wakeEventSchema.parse({
      id: 'wake-prepare',
      ownerId: OWNER,
      agentId,
      conversationId: 'conversation-prepare',
      sessionKey: 'agent:' + agentId,
      kind: 'user_message',
      origin: { type: 'user' },
      trusted: true,
      priority: 'user',
      payload: { text: 'prepare' },
      at: AT,
    }),
    step: async (_name, fn) => fn(),
    signal: signal ?? new AbortController().signal,
    ...(systemOne === undefined ? {} : { systemOne }),
  };
}

/** The owner's skills for the scoped-store test; the agent selects the first two. */
const SCOPED_SKILLS = createFakeSkills([
  skillRow('skill-pdf', 'pdf_lookup', 'Find text inside PDF documents', 'BODY: read every PDF page.'),
  skillRow('skill-mail', 'mail_triage', 'Sort messages by priority', 'BODY: sort the mailbox.'),
]);

async function scopedStore(): Promise<ToolContext['store']> {
  const store = ownedMemoryStore();
  await store.put('agents', agentRow(['skill-pdf', 'skill-mail']));
  return store;
}

interface SeenAsk {
  state: string;
  questions: Record<string, SystemOneQuestion>;
  options: { allowEmulation?: boolean } | undefined;
}

function ranker(relevantMarkers: readonly string[]): { systemOne: SystemOne; ask: ReturnType<typeof vi.fn>; seen: SeenAsk[] } {
  const seen: SeenAsk[] = [];
  const ask = vi.fn(async (
    state: string,
    questions: Record<string, SystemOneQuestion>,
    _signal: AbortSignal,
    options?: { allowEmulation?: boolean },
  ): Promise<Record<string, SystemOneAnswer>> => {
    seen.push({ state, questions, options });
    const answers: Record<string, SystemOneAnswer> = {};
    for (const [key, question] of Object.entries(questions)) {
      if (question.type !== 'score') {
        answers[key] = { type: 'noul', probability: 0 };
        continue;
      }
      const relevant = relevantMarkers.some((marker) => question.instructions.includes(marker));
      answers[key] = relevant
        ? { type: 'score', score: 3, probabilities: [0, 0, 0.05, 0.95], confidence: 0.99 }
        : { type: 'score', score: 0, probabilities: [0.95, 0.04, 0.01, 0], confidence: 0.99 };
    }
    return answers;
  });
  return { systemOne: { ask }, ask, seen };
}

function textOf(result: { content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }> }): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

beforeEach(() => {
  clearDiscoveryMemo();
  vi.stubEnv('TOOL_DISCLOSURE', 'compact');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('first-turn tool preparation', () => {
  for (const mode of ['legacy', 'off']) {
    it('returns no preparation in ' + mode + ' mode', async () => {
      vi.stubEnv('TOOL_DISCLOSURE', mode);
      const all = vi.fn(async () => [deferredTool('archive_mail', 'Archive mail')]);
      const result = await createToolPreparer({ all })('archive mail', context());
      expect(result.content).toEqual([]);
      expect(result.details).toMatchObject({ mode, ranking: 'none', selectedToolCount: 0, noteChars: 0 });
      expect(all).not.toHaveBeenCalled();
    });
  }

  it('always returns the compact canonical namespace and account directory without Jev', async () => {
    const emailWork = mcpTool('mcp__mail__read_work', 'mail-work', 'Mail', 'work@example.com', 'Read the work inbox');
    const emailMe = mcpTool('mcp__mail__read_me', 'mail-me', 'Mail', 'me@example.com', 'Read the personal inbox');
    const all = vi.fn(async () => [visibleTool('tool_search'), emailWork, emailMe]);
    const result = await createToolPreparer({ all })('read mail', context());
    const note = textOf(result);
    expect(all).toHaveBeenCalledTimes(1);
    expect(note).toContain('Namespace directory');
    expect(note).toContain('mcp__mail__work_example_com__*');
    expect(note).toContain('mcp__mail__me_example_com__*');
    expect(note).toContain('mcp__mail__read_work');
    expect(note).toContain('mcp__mail__read_me');
    expect(note).toContain('Closest local metadata');
    expect(note).not.toContain('complete JSON parameters:');
    expect(result.details).toMatchObject({ ranking: 'lexical', reason: 'no-system-one', selectedToolCount: 0 });
  });

  it('keeps the directory when native Jev is unavailable and requests no emulation', async () => {
    const ask = vi.fn(async (
      _state: string,
      _questions: Record<string, SystemOneQuestion>,
      _signal: AbortSignal,
      _options?: { allowEmulation?: boolean },
    ): Promise<Record<string, SystemOneAnswer> | null> => null);
    const tool = deferredTool('archive_mail', 'Archive the mail');
    const result = await createToolPreparer({ all: async () => [tool] })(
      'archive mail',
      context(undefined, { ask }, undefined, AGENT, 'run-no-jev'),
    );
    const note = textOf(result);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[3]?.allowEmulation).toBe(false);
    expect(note).toContain('Namespace directory');
    expect(note).toContain('Semantic ranking was unavailable (unavailable)');
    expect(note).not.toContain('complete JSON parameters:');
    expect(result.details).toMatchObject({ reason: 'unavailable', semantic: false, selectedToolCount: 0 });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('defaults a missing relevantCount to zero instead of backfilling lexical remainder', () => {
    const relevant = deferredTool('search_notes', 'Find saved notes');
    const irrelevant = deferredTool('archive_mail', 'Archive the mailbox');
    const pool = buildCandidatePool([relevant, irrelevant], [], [], 'notes');
    const outcome: RankOutcome = {
      order: pool.candidates.map((_candidate, index) => index),
      semantic: true,
      reason: 'semantic',
      omitted: 0,
    };
    const rendered = renderRankedNote(pool.candidates, outcome);
    expect(rendered.selectedTools).toBe(0);
    expect(rendered.text).not.toContain(JSON.stringify({ name: relevant.name }));
    expect(rendered.text).not.toContain(JSON.stringify({ name: irrelevant.name }));
  });

  it('lists a tool whose unchanged definition the model already holds by name only, and sends new or changed ones in full', () => {
    const search = deferredTool('web_search', 'Search the web for pages');
    const fetchPage = deferredTool('web_fetch', 'Fetch one page');
    const rank = (pool: ReturnType<typeof buildCandidatePool>): RankOutcome => ({ order: pool.candidates.map((_candidate, index) => index), semantic: true, reason: 'semantic', omitted: 0, relevantCount: pool.candidates.length });
    const pool = buildCandidatePool([search, fetchPage], [], [], 'web');
    const first = renderRankedNote(pool.candidates, rank(pool));
    expect(first.definedTools).toHaveLength(2);
    expect(first.text).toContain('complete JSON parameters:');
    expect(first.text).not.toContain('Already described above');

    const again = renderRankedNote(pool.candidates, rank(pool), new Set(first.definedTools));
    expect(again.text).toMatch(/Already described above in this conversation[^\n]*web_search/);
    expect(again.text).toMatch(/Already described above in this conversation[^\n]*web_fetch/);
    expect(again.text).not.toContain('complete JSON parameters:');
    expect(again.text).not.toContain('Search the web for pages');
    expect(again).toMatchObject({ selectedTools: 0, reusedTools: 2, definedTools: [] });

    const changed = deferredTool('web_search', 'Search the web for pages, newest first');
    const mixedPool = buildCandidatePool([changed, fetchPage, deferredTool('web_crawl', 'Crawl a site')], [], [], 'web');
    const mixed = renderRankedNote(mixedPool.candidates, rank(mixedPool), new Set(first.definedTools));
    expect(mixed.text).toContain('Search the web for pages, newest first');
    expect(mixed.text).toContain('Crawl a site');
    expect(mixed.text).not.toContain('Fetch one page');
    expect(mixed.text).toMatch(/Already described above in this conversation[^\n]*web_fetch/);
    expect(mixed).toMatchObject({ selectedTools: 2, reusedTools: 1 });
  });

  it('asks one combined closed question per tool and skill, filters the visible core, and reads no skill body', async () => {
    const store = await scopedStore();
    const notion = mcpTool('mcp__notion__search', 'notion-1', 'Notion', 'work', 'Search workspace pages. SERVER GUIDANCE: pass the exact filter.');
    const unrelated = deferredTool('archive_mail', 'Move mail into archive');
    const parameters = {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Pages containing this text' },
        limit: { type: 'number', minimum: 1 },
      },
      required: ['filter'],
      additionalProperties: false,
    };
    notion.parameters = parameters;
    const ranked = ranker(['mcp__notion__search', 'pdf_lookup']);
    const result = await createToolPreparer({ all: async () => [visibleTool('tool_search'), notion, unrelated], skills: SCOPED_SKILLS })(
      'find the notion page about the PDF',
      context(store, ranked.systemOne),
    );
    const note = textOf(result);
    expect(ranked.ask).toHaveBeenCalledTimes(1);
    expect(ranked.seen[0]?.options?.allowEmulation).toBe(false);
    const asked = JSON.stringify(ranked.seen[0]?.questions);
    expect(asked).toContain('mcp__notion__search');
    expect(asked).toContain('app=Notion');
    expect(asked).toContain('pdf_lookup');
    expect(asked).not.toContain('tool_search');
    expect(asked).not.toContain('BODY:');
    expect(note).toContain('mcp__notion__search');
    expect(note).toContain('SERVER GUIDANCE: pass the exact filter.');
    expect(note).toContain('complete JSON parameters: ' + JSON.stringify(parameters));
    expect(note).toContain('pdf_lookup');
    expect(note).not.toContain('BODY:');
    expect(result.details).toMatchObject({ selectedToolCount: 1, selectedSkillCount: 1, semantic: true });
    expect(notion.execute).not.toHaveBeenCalled();
    expect(unrelated.execute).not.toHaveBeenCalled();
  });

  it('keeps an authorized prerequisite skill and its needed tool in one explicit-app decision', async () => {
    const store = ownedMemoryStore();
    await store.put('agents', agentRow(['skill-meeting']));
    const meetingSkills = createFakeSkills([skillRow('skill-meeting', 'meeting_briefing', 'Prepare a briefing for the current meeting', 'BODY: read the skill and prepare it.')]);
    const notes = mcpTool('mcp__notes__search_notes', 'notes', 'Notes', 'Work', 'Search notes for the current meeting code.');
    const gmail = mcpTool('mcp__gmail__folder', 'gmail', 'Gmail', 'Work', 'List mail folders.');
    const ask = vi.fn(async (_state: string, questions: Record<string, SystemOneQuestion>): Promise<Record<string, SystemOneAnswer>> =>
      Object.fromEntries(Object.entries(questions).map(([key, question]) => {
        const relevant = question.instructions.includes('meeting_briefing') ||
          (question.instructions.includes('search_notes') && question.instructions.includes('IN STATE') && question.instructions.includes('including a prerequisite'));
        return [key, relevant
          ? { type: 'score' as const, score: 3, probabilities: [0, 0, 0.05, 0.95], confidence: 0.99 }
          : { type: 'score' as const, score: 0, probabilities: [0.95, 0.04, 0.01, 0], confidence: 0.99 }];
      })));
    const result = await createToolPreparer({ all: async () => [notes, gmail], skills: meetingSkills })(
      'Use my selected Meeting code briefing skill to retrieve the current meeting code from Notes and prepare the briefing. Read the skill instructions first.',
      context(store, { ask }),
    );
    const note = textOf(result);
    expect(note).toContain('complete JSON parameters: ' + JSON.stringify(notes.parameters));
    expect(note).toContain('### skill meeting_briefing');
    expect(note).not.toContain('BODY:');
    expect(JSON.stringify(ask.mock.calls)).not.toContain('mcp__gmail__folder');
    expect(result.details).toMatchObject({ scope: 'explicit', selectedToolCount: 1, selectedSkillCount: 1 });
  });

  it('keeps an explicit app pool near that app instead of admitting unrelated production-style builtins', async () => {
    const notes = Array.from({ length: 31 }, (_, index) =>
      mcpTool('mcp__notes__meeting_' + String(index), 'notes', 'Notes', 'Work', 'Search the current meeting code.'));
    const builtins = Array.from({ length: 80 }, (_, index) =>
      deferredTool('builtin_' + String(index).padStart(2, '0'), 'Use the item to do work.'));
    const files = deferredTool('files_search', 'Search named files.');
    const gmail = Array.from({ length: 90 }, (_, index) =>
      mcpTool('mcp__gmail__folder_' + String(index), 'gmail', 'Gmail', 'Work', 'List mail folders.'));
    const ranked = ranker(['meeting_1', 'files_search']);
    const result = await createToolPreparer({ all: async () => [...notes, ...builtins, files, ...gmail] })(
      'Use the connected Notes app to look up the meeting code in files',
      context(undefined, ranked.systemOne),
    );
    const count = Object.keys(ranked.seen[0]?.questions ?? {}).length;
    expect(count).toBeGreaterThan(31);
    expect(count).toBeLessThanOrEqual(40);
    expect(JSON.stringify(ranked.seen[0]?.questions)).not.toContain('mcp__gmail__folder');
    expect(textOf(result)).toContain(JSON.stringify(files.parameters));
    expect(result.details).toMatchObject({ scope: 'explicit', toolCount: 202, omitted: 170 });
  });

  it('keeps broad namespace coverage when an available connector word is ambiguous', async () => {
    const google = mcpTool('mcp__google_calendar__search', 'google-calendar', 'Google Calendar', 'Work@example.com', 'Search Google calendars.');
    const outlook = mcpTool('mcp__outlook_calendar__search', 'outlook-calendar', 'Outlook Calendar', 'Work@example.com', 'Search Outlook calendars.');
    const ranked = ranker(['google_calendar__search', 'outlook_calendar__search']);
    const result = await createToolPreparer({ all: async () => [google, outlook] })('check my calendar', context(undefined, ranked.systemOne));
    const asked = JSON.stringify(ranked.seen[0]?.questions);
    expect(asked).toContain('google_calendar__search');
    expect(asked).toContain('outlook_calendar__search');
    expect(result.details).toMatchObject({ scope: 'broad' });
  });

  it("rechecks skill dependencies against this run's tools before it lists the skills", async () => {
    const tool = deferredTool('notes_search', 'Find saved notes');
    const checked: Array<string | undefined> = [];
    const spy: SkillsService = {
      ...SCOPED_SKILLS,
      async recheck(_ownerId, tools) {
        checked.push(tools('notes_search'));
        return { pinned: 0, reviewed: [] };
      },
    };
    await createToolPreparer({ all: async () => [tool], skills: spy })('find notes', context());
    expect(checked).toEqual([toolHashes([tool])('notes_search')]);
  });

  it('skips exact bare Chinese greetings while ranking a Chinese task that contains one', async () => {
    const ranked = ranker(['search_notes']);
    const prepare = createToolPreparer({ all: async () => [deferredTool('search_notes', 'Find saved notes')] });
    const greeting = await prepare('你好！', context(undefined, ranked.systemOne));
    expect(ranked.ask).not.toHaveBeenCalled();
    expect(greeting.details).toMatchObject({ reason: 'greeting' });
    await prepare('你好，帮我查Notes', context(undefined, ranked.systemOne));
    expect(ranked.ask).toHaveBeenCalledTimes(1);
  });

  it('skips Jev and definitions for greetings while retaining the directory', async () => {
    const ranked = ranker(['archive_mail']);
    const all = vi.fn(async () => [deferredTool('archive_mail', 'Archive mail into the mailbox')]);
    const result = await createToolPreparer({ all })('hello!', context(undefined, ranked.systemOne));
    const note = textOf(result);
    expect(ranked.ask).not.toHaveBeenCalled();
    expect(note).toContain('Namespace directory');
    expect(note).toContain('archive_mail');
    expect(note).not.toContain('complete JSON parameters:');
    expect(result.details).toMatchObject({ reason: 'greeting', selectedToolCount: 0, selectedSkillCount: 0 });
  });

  it('keeps the directory when Jev is incomplete or throws', async () => {
    const variants: Array<{ systemOne: SystemOne; reason: string }> = [
      { systemOne: { ask: async () => ({}) }, reason: 'invalid' },
      { systemOne: { ask: async () => { throw new Error('Jev down'); } }, reason: 'ask-error' },
    ];
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index];
      if (variant === undefined) continue;
      const tool = deferredTool('archive_mail', 'Archive the mail');
      const result = await createToolPreparer({ all: async () => [tool] })(
        'archive mail',
        context(undefined, variant.systemOne, undefined, AGENT, 'run-error-' + String(index)),
      );
      const note = textOf(result);
      expect(note).toContain('Namespace directory');
      expect(note).toContain('archive_mail');
      expect(note).not.toContain('complete JSON parameters:');
      expect(result.details).toMatchObject({ reason: variant.reason, semantic: false });
      expect(tool.execute).not.toHaveBeenCalled();
    }
  });

  it('memoizes the exact owner, agent, run, query and ordered catalog identity', async () => {
    const target = deferredTool('search_notes', 'Find saved notes');
    const other = deferredTool('archive_mail', 'Archive mail');
    let catalog = [target];
    const all = vi.fn(async () => catalog);
    const ranked = ranker(['search_notes']);
    const prepare = createToolPreparer({ all });
    const base = context(undefined, ranked.systemOne);

    const first = await prepare('find notes', base);
    const second = await prepare('find notes', base);
    expect(ranked.ask).toHaveBeenCalledTimes(1);
    expect(textOf(second)).toContain('search_notes');

    await prepare('find notes', { ...base, ownerId: 'owner-other' });
    await prepare('find notes', { ...base, agentId: 'agent-other' });
    await prepare('find notes', { ...base, runId: 'run-other' });
    expect(ranked.ask).toHaveBeenCalledTimes(4);

    catalog = [{ ...target, parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
    await prepare('find notes', base);
    expect(ranked.ask).toHaveBeenCalledTimes(5);

    catalog = [target, other];
    await prepare('find notes', base);
    catalog = [other, target];
    await prepare('find notes', base);
    expect(ranked.ask).toHaveBeenCalledTimes(7);
    expect(textOf(first)).toContain('Namespace directory');
  });

  it('bounds the pool at 80 with namespace diversity and emits only whole JSON schemas that fit', async () => {
    const tools: Tool[] = [];
    for (let group = 0; group < 30; group += 1) {
      for (let member = 0; member < 3; member += 1) {
        tools.push(deferredTool('grp' + String(group).padStart(2, '0') + '_tool_' + String(member), 'Group ' + String(group) + ' operation'));
      }
    }
    const hugeParameters = {
      type: 'object',
      properties: { payload: { type: 'string', description: 'x'.repeat(20_000) } },
    };
    const serverParameters = {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Exact server filter' } },
      required: ['filter'],
      additionalProperties: false,
    };
    const huge = deferredTool('aaa_huge_tool', 'Huge complete definition with server marker', hugeParameters);
    const server = deferredTool('zzz_server_tool', 'SERVER INSTRUCTIONS: use the filter exactly.', serverParameters);
    tools.push(huge, server);
    const ranked = ranker(['aaa_huge_tool', 'zzz_server_tool']);
    const result = await createToolPreparer({ all: async () => tools })('server filter', context(undefined, ranked.systemOne));
    const note = textOf(result);
    expect(ranked.ask).toHaveBeenCalledTimes(1);
    expect(Object.keys(ranked.seen[0]?.questions ?? {})).toHaveLength(80);
    const questions = Object.values(ranked.seen[0]?.questions ?? {}).map((question) => question.instructions).join(' ');
    expect(questions).toContain('namespace=grp00');
    expect(questions).toContain('namespace=grp29');
    expect(note.length).toBeLessThanOrEqual(MAX_PREPARE_NOTE_CHARS);
    expect(note).toContain('SERVER INSTRUCTIONS: use the filter exactly.');
    expect(note).not.toContain(JSON.stringify(hugeParameters));
    expect(note).toContain('fetch them with tool_search');
    const marker = 'complete JSON parameters: ';
    const start = note.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = note.indexOf('\n', start);
    const encoded = note.slice(start + marker.length, end === -1 ? note.length : end);
    expect(JSON.parse(encoded)).toEqual(serverParameters);
    expect(result.details).toMatchObject({ selectedToolCount: 1, omittedDefinitions: 1 });
    for (const tool of tools) expect(tool.execute).not.toHaveBeenCalled();
  });

  it('rethrows caller cancellation before work and during ranking', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('cancelled-before'));
    const idle = vi.fn(async () => [deferredTool('search_notes', 'Find notes')]);
    await expect(createToolPreparer({ all: idle })('find notes', context(undefined, undefined, aborted.signal))).rejects.toThrow('cancelled-before');
    expect(idle).not.toHaveBeenCalled();

    const controller = new AbortController();
    const waitingAsk = vi.fn(async (
      _state: string,
      _questions: Record<string, SystemOneQuestion>,
      signal: AbortSignal,
    ): Promise<Record<string, SystemOneAnswer>> => await new Promise((_resolve, reject) => {
      const fail = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    }));
    const pending = createToolPreparer({ all: async () => [deferredTool('search_notes', 'Find notes')] })(
      'find notes',
      context(undefined, { ask: waitingAsk }, controller.signal),
    );
    await vi.waitFor(() => expect(waitingAsk).toHaveBeenCalledTimes(1));
    controller.abort(new Error('cancelled-during'));
    await expect(pending).rejects.toThrow('cancelled-during');
  });
});
