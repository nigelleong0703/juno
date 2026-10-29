import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemOne, SystemOneAnswer, SystemOneQuestion } from '../../../ports/system-one/index.js';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { clearDiscoveryMemo } from '../tools/discoveryMemo.js';
import { createToolLoadTool, createToolSearchTool } from '../tools/toolSearch.js';

function tool(name: string, app: string, description: string, parameter: string, connectionId?: string): Tool {
  return { name, description, mcp: true, replay: 'safe', sideEffect: false,
    origin: { connectionId: connectionId ?? app, connectionName: app, toolName: name, access: 'read' },
    parameters: { type: 'object', properties: { [parameter]: { type: 'string' } }, required: [parameter] },
    execute: vi.fn(async () => ({ content: [] })),
  };
}

function context(text: string, systemOne?: SystemOne, runId = 'run-bundle'): ToolContext {
  return { ownerId: 'owner-bundle', agentId: 'agent-bundle', conversationId: 'chat-bundle', runId,
    store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: wakeEventSchema.parse({ id: 'wake', ownerId: 'owner-bundle', agentId: 'agent-bundle', conversationId: 'chat-bundle', sessionKey: 'agent-bundle:chat-bundle', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text }, at: '2026-10-20T00:00:00Z' }),
    step: async (_name, fn) => fn(), signal: new AbortController().signal,
    ...(systemOne === undefined ? {} : { systemOne }),
  };
}

const textOf = (result: ToolResult): string => result.content.map((part) => part.type === 'text' ? part.text : '').join('\n');

function scoringAsk(target: string) {
  return vi.fn(async (_state: string, questions: Record<string, SystemOneQuestion>): Promise<Record<string, SystemOneAnswer>> => {
    const out: Record<string, SystemOneAnswer> = {};
    for (const key of Object.keys(questions)) {
      const relevant = (questions[key]?.instructions ?? '').includes(target);
      out[key] = relevant
        ? { type: 'score', score: 3, probabilities: [0, 0, 0.05, 0.95], confidence: 0.99 }
        : { type: 'score', score: 0, probabilities: [0.95, 0.04, 0.01, 0], confidence: 0.99 };
    }
    return out;
  });
}

beforeEach(() => {
  clearDiscoveryMemo();
});

describe('discovery bundles', () => {
  it('returns complete schemas for several useful matches in one query', async () => {
    const tools = [
      tool('search_notes', 'Notes', 'Search saved notes before creating notes.', 'needle'),
      tool('create_note', 'Notes', 'Create saved notes from a title and body.', 'titleAndBody'),
      tool('update_note', 'Notes', 'Update a saved note title and body.', 'noteId'),
    ];
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ query: 'search create update notes' }, context('Search then create then update notes'));
    for (const entry of tools) expect(textOf(result)).toContain(JSON.stringify(entry.parameters));
    for (const entry of tools) expect(entry.execute).not.toHaveBeenCalled();
  });

  it('bounds bundled schemas while never cutting the first best', async () => {
    const big = (name: string, key: string): Tool => ({ ...tool(name, 'Tall', 'alpha tool ' + key, key),
      parameters: { type: 'object', properties: { [key]: { type: 'string', description: 'x'.repeat(9000) } }, required: [key] } });
    const tools = [big('tool_alpha_1', 'p1'), big('tool_alpha_2', 'p2'), big('tool_alpha_3', 'p3')];
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ query: 'alpha tool' }, context('alpha tool', undefined, 'run-budget'));
    const text = textOf(result);
    expect(text).toContain(JSON.stringify(tools[0]?.parameters));
    expect(text).toContain(JSON.stringify(tools[1]?.parameters));
    expect(text).not.toContain('"p3":');
    for (const entry of tools) expect(text).toContain(entry.name);
    for (const entry of tools) expect(entry.execute).not.toHaveBeenCalled();
  });

  it('orders a namespace listing by the wake hint past fillers with no model call', async () => {
    const useful = tool('search_notes', 'Notes', 'Search saved notes for the current meeting code.', 'meetingNeedle');
    const tools = [...Array.from({ length: 12 }, (_, i) => tool('label_' + String(i), 'Notes', 'List a label.', 'label')), useful];
    const ask = vi.fn(async () => null);
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ query: '', namespace: 'mcp__notes__*' }, context('Search Notes for the current meeting code', { ask }, 'run-hint'));
    expect(ask).not.toHaveBeenCalled();
    expect(textOf(result)).toContain(JSON.stringify(useful.parameters));
    expect(textOf(result)).toContain('more tools in this scope');
    for (const entry of tools) expect(entry.execute).not.toHaveBeenCalled();
  });

  it('fetches an exact canonical query with no relevance decision', async () => {
    const ask = vi.fn(async () => null);
    const useful = tool('mcp__notes__search_notes', 'Notes', 'Search notes', 'needle');
    const search = createToolSearchTool({ all: async () => [useful], visible: async () => new Set() });
    const result = await search.execute({ query: useful.name }, context('Find notes', { ask }, 'run-exact'));
    expect(textOf(result)).toContain(JSON.stringify(useful.parameters));
    expect(ask).not.toHaveBeenCalled();
    expect(useful.execute).not.toHaveBeenCalled();
  });

  it('fetches exact names with full schemas and honest misses, never executing', async () => {
    const ask = vi.fn(async () => null);
    const first = tool('search_notes', 'Notes', 'Search saved notes.', 'needle');
    const second = tool('create_note', 'Notes', 'Create a saved note.', 'titleAndBody');
    const load = createToolLoadTool({ all: async () => [first, second], visible: async () => new Set() });
    const result = await load.execute({ names: [first.name, second.name, 'no_such_tool'] }, context('Fetch known tools', { ask }, 'run-names'));
    const text = textOf(result);
    expect(text).toContain(JSON.stringify(first.parameters));
    expect(text).toContain(JSON.stringify(second.parameters));
    expect(text).toContain('no_such_tool');
    expect(ask).not.toHaveBeenCalled();
    expect(first.execute).not.toHaveBeenCalled();
    expect(second.execute).not.toHaveBeenCalled();
  });

  it('fails an all-unknown names fetch without executing', async () => {
    const known = tool('search_notes', 'Notes', 'Search saved notes.', 'needle');
    const load = createToolLoadTool({ all: async () => [known], visible: async () => new Set() });
    const result = await load.execute({ names: ['ghost_tool'] }, context('Fetch unknown', undefined, 'run-ghost'));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('ghost_tool');
    expect(known.execute).not.toHaveBeenCalled();
  });

  it('keeps namespace scopes isolated across accounts', async () => {
    const work = { ...tool('mcp__mail__read_work', 'Mail', 'Read the work inbox.', 'folder'), origin: { connectionId: 'mail-work', connectionName: 'Mail', account: 'work@example.com', toolName: 'read_work', access: 'read' as const } };
    const me = { ...tool('mcp__mail__read_me', 'Mail', 'Read the personal inbox.', 'folder'), origin: { connectionId: 'mail-me', connectionName: 'Mail', account: 'me@example.com', toolName: 'read_me', access: 'read' as const } };
    const search = createToolSearchTool({ all: async () => [work, me], visible: async () => new Set() });
    const result = await search.execute({ query: '', namespace: 'mcp__mail__work_example_com__*' }, context('Read work mail', undefined, 'run-scope'));
    expect(textOf(result)).toContain('mcp__mail__read_work');
    expect(textOf(result)).not.toContain('mcp__mail__read_me');
  });

  it('fails a truly unknown namespace closed without widening the scope', async () => {
    const gmail = tool('gmail_search', 'Gmail', 'Search mail folders.', 'folder', 'gmail-1');
    const search = createToolSearchTool({ all: async () => [gmail], visible: async () => new Set() });
    const result = await search.execute({ query: '', namespace: 'bogus-connector-xyz' }, context('Search mail', undefined, 'run-unknown'));
    expect(textOf(result)).toContain('No namespace matches');
    expect(textOf(result)).not.toContain('gmail_search');
    expect(gmail.execute).not.toHaveBeenCalled();
  });

  it('reuses one ranking for an identical repeated query', async () => {
    const tools = [tool('archive_mail', 'Mail', 'Archive mail into folders.', 'folder'), tool('notion_lookup', 'Notion', 'Look up pages in Notion.', 'page')];
    const ask = scoringAsk('notion_lookup');
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const first = await search.execute({ query: 'lookup notion pages' }, context('lookup', { ask }, 'run-memo'));
    const second = await search.execute({ query: 'lookup notion pages' }, context('lookup', { ask }, 'run-memo'));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(textOf(first)).toBe(textOf(second));
    expect(textOf(first)).toContain(JSON.stringify(tools[1]?.parameters));
  });
  it('keeps confident irrelevant rest as metadata on a semantic decision', async () => {
    const relevant = tool('notion_lookup', 'Notion', 'Look up pages in Notion.', 'page');
    const fillers = Array.from({ length: 5 }, (_, i) => tool('fill_' + String(i), 'Misc', 'Unrelated filler entry.', 'fill' + String(i)));
    const ask = scoringAsk('notion_lookup');
    const search = createToolSearchTool({ all: async () => [relevant, ...fillers], visible: async () => new Set() });
    const result = await search.execute({ query: 'lookup notion pages' }, context('lookup', { ask }, 'run-semantic-bundle'));
    const text = textOf(result);
    expect(text).toContain(JSON.stringify(relevant.parameters));
    for (const filler of fillers) {
      expect(text).toContain(filler.name);
      expect(text).not.toContain(JSON.stringify(filler.parameters));
      expect(filler.execute).not.toHaveBeenCalled();
    }
    expect(relevant.execute).not.toHaveBeenCalled();
  });
});
