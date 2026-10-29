/**
 * The tool side of native deferred loading: the search answers with the names it loaded (the provider sends their definitions),
 * the run's tool list carries the hidden tools after the shown ones, `react` joins the core tools in a chat that takes reactions,
 * and the discovery directory names tools the way the model can call them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { clearDiscoveryMemo } from '../tools/discoveryMemo.js';
import { groupNamespaces, renderNamespaceDirectory } from '../tools/namespaceDirectory.js';
import { createToolSearchTool, presentForModel, toolsForModel } from '../tools/toolSearch.js';
import { createToolNameAliases } from '../../../execution/brain/toolNames.js';

function tool(name: string, description: string, extra: Partial<Tool> = {}): Tool {
  return {
    name, description, replay: 'safe', sideEffect: false, deferLoading: true,
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: vi.fn(async () => ({ content: [] })), ...extra,
  };
}

function context(text: string, toolSearch?: ToolContext['toolSearch']): ToolContext {
  return {
    ownerId: 'o', agentId: 'a', conversationId: 'c', runId: 'run-native', store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: wakeEventSchema.parse({ id: 'w', ownerId: 'o', agentId: 'a', conversationId: 'c', sessionKey: 'a:c', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text }, at: '2026-10-20T00:00:00Z' }),
    step: async (_name, fn) => fn(), signal: new AbortController().signal,
    ...(toolSearch === undefined ? {} : { toolSearch }),
  };
}
const textOf = (result: ToolResult): string => result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

beforeEach(() => clearDiscoveryMemo());

describe('tool_search on a model with native deferred loading', () => {
  const notes = [tool('search_notes', 'Search saved notes by words.'), tool('create_note', 'Create a saved note.'), tool('weather.get', 'Current weather for a city.')];
  const search = createToolSearchTool({ all: async () => notes, visible: async () => new Set() });

  it('answers with the names it loaded and no proxy instructions; the proxy answer still carries the schema and tool_call', async () => {
    const native = await search.execute({ query: 'search saved notes' }, context('search notes', 'responses-tool-search'));
    expect(textOf(native)).toContain('Loaded');
    expect(textOf(native)).not.toContain('tool_call');
    expect(native.details?.['loadedTools']).toEqual(expect.arrayContaining(['search_notes']));
    for (const entry of notes) expect(entry.execute).not.toHaveBeenCalled();

    const proxy = await search.execute({ query: 'search saved notes' }, context('search notes'));
    expect(textOf(proxy)).toContain('tool_call');
    expect(proxy.details).not.toHaveProperty('loadedTools');
  });

  it('loads an exact tool name, and does not load a tool the model already has', async () => {
    const exact = await search.execute({ query: 'weather.get' }, context('weather', 'responses-tool-search'));
    expect(exact.details?.['loadedTools']).toEqual(['weather.get']);
    const held = createToolSearchTool({ all: async () => notes, visible: async () => new Set(['weather.get']) });
    const again = await held.execute({ query: 'weather.get' }, context('weather', 'responses-tool-search'));
    expect(again.details?.['loadedTools']).toEqual([]);
    expect(textOf(again)).toContain('Already in your list');
  });
});

describe('the tool list a run hands to the model call', () => {
  const core = [tool('send_message', 'Send.', { deferLoading: false }), tool('tool_search', 'Search.', { deferLoading: false }), tool('tool_call', 'Call.', { deferLoading: false })];
  const rest = [tool('react', 'React with an emoji.'), tool('shell.run', 'Run a command.'), tool('notes_search', 'Search notes.', { mcp: true, deferLoading: undefined })];

  it('puts the hidden tools after the shown ones, marked deferred', () => {
    const list = toolsForModel([rest[1]!, core[0]!, rest[2]!, core[1]!, core[2]!], {});
    expect(list.map((entry) => [entry.name, entry.deferLoading === true])).toEqual([
      ['send_message', false], ['tool_search', false], ['tool_call', false], ['shell.run', true], ['notes_search', true],
    ]);
  });

  it('makes react a core tool only in a chat that takes reactions', () => {
    const all = [...core, ...rest];
    expect(presentForModel(all, {}).map((entry) => entry.name)).not.toContain('react');
    expect(presentForModel(all, {}, { reactions: true }).map((entry) => entry.name)).toContain('react');
    expect(toolsForModel(all, {}).find((entry) => entry.name === 'react')?.deferLoading).toBe(true);
    expect(toolsForModel(all, {}, { reactions: true }).find((entry) => entry.name === 'react')?.deferLoading).toBe(false);
  });
});

describe('the discovery directory', () => {
  const groups = groupNamespaces([tool('shell.run', 'Run a command.'), tool('shell.start', 'Start a command.')]);

  it('names tools as the model can call them when it has native loading, and keeps the tool_call wording otherwise', () => {
    const aliases = createToolNameAliases(['shell.run', 'shell.start']);
    const native = renderNamespaceDirectory(groups, (name) => aliases.toProtocol(name));
    expect(native).toContain('shell_run, shell_start');
    expect(native).not.toContain('tool_call');
    const proxy = renderNamespaceDirectory(groups);
    expect(proxy).toContain('shell.run, shell.start');
    expect(proxy).toContain('tool_call');
  });
});
