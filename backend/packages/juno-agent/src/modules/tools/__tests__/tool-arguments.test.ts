import { describe, expect, it } from 'vitest';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createCalendarTools } from '../tools/calendarTools.js';
import { createToolLoadTool, createToolSearchTool } from '../tools/toolSearch.js';
import { createWebSearchTool } from '../tools/webSearch.js';
import { checkArguments, normalizeOptionalStrings, publicParameters } from '../toolArguments.js';

const textOf = (result: ToolResult): string => result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

function context(): ToolContext {
  return {
    ownerId: 'owner', agentId: 'agent', conversationId: 'chat', runId: 'run',
    store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: wakeEventSchema.parse({ id: 'wake', ownerId: 'owner', agentId: 'agent', conversationId: 'chat', sessionKey: 'agent:chat', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'hi' }, at: '2026-10-24T00:00:00Z' }),
    step: async (_name, fn) => fn(), signal: new AbortController().signal,
  };
}

/** The schedule_add tool as the model sees it: optional strings nullable. */
const scheduleAdd = (): Tool => {
  const tool = createCalendarTools()[0]!;
  return { ...tool, parameters: publicParameters(tool.parameters) };
};

describe('optional strings: "" means absent', () => {
  it('leaves out an optional "", blank or null at any depth, and says what it left out', () => {
    const { args, normalized } = normalizeOptionalStrings(scheduleAdd(), {
      kind: 'meeting', title: 'Standup', at: '2026-10-25T09:00', instructions: 'Join.', endAt: '', timezone: '   ', meeting: { platform: 'discord', channelId: '', url: null },
    });
    expect(args).toEqual({ kind: 'meeting', title: 'Standup', at: '2026-10-25T09:00', instructions: 'Join.', meeting: { platform: 'discord' } });
    expect(normalized).toEqual([
      { field: 'endAt', was: 'empty' }, { field: 'timezone', was: 'whitespace' },
      { field: 'meeting.channelId', was: 'empty' }, { field: 'meeting.url', was: 'null' },
    ]);
  });

  it('never touches a required field, and keeps a real value', () => {
    const tool = scheduleAdd();
    const sent = { kind: 'task', title: '', at: '2026-10-25T09:00', instructions: 'Do it.', timezone: 'Europe/Paris' };
    const { args, normalized } = normalizeOptionalStrings(tool, sent);
    expect(args).toBe(sent);
    expect(normalized).toEqual([]);
  });

  it('lets an update tool clear a value with an explicit null, and still treats "" as not provided', () => {
    const update = createCalendarTools()[3]!;
    expect(update.name).toBe('schedule_update');
    const publicUpdate = { ...update, parameters: publicParameters(update.parameters) };
    expect(normalizeOptionalStrings(publicUpdate, { id: 'cal-1', endAt: null, result: null }).args).toEqual({ id: 'cal-1', endAt: null });
    expect(normalizeOptionalStrings(publicUpdate, { id: 'cal-1', endAt: '' }).args).toEqual({ id: 'cal-1' });
  });

  it('declares an optional string as ["string","null"] in the schema the model is shown, and nothing else', () => {
    const shown = publicParameters(createCalendarTools()[0]!.parameters);
    const properties = shown['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['endAt']?.['type']).toEqual(['string', 'null']);
    expect((properties['meeting']?.['properties'] as Record<string, Record<string, unknown>>)['channelId']?.['type']).toEqual(['string', 'null']);
    expect(properties['title']?.['type']).toBe('string');
    expect(properties['kind']?.['enum']).toEqual(['follow_up', 'meeting', 'task']);
    expect(checkArguments({ parameters: shown }, { kind: 'task', title: 't', at: 'x', instructions: 'i', endAt: null })).toEqual([]);
  });
});

describe('validation errors teach', () => {
  it('names the field, what was received, what is expected and a corrected example (web_search, empty query)', async () => {
    const tool = createWebSearchTool({ provider: { name: 'test', search: async () => [] } });
    const result = await tool.execute({ query: '' }, context());
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ errorKind: 'validation' });
    const text = textOf(result);
    expect(text).toContain('Error: invalid web_search arguments.');
    expect(text).toContain('- query: received an empty string; expected a non-empty string.');
    expect(text).not.toContain('"code"');
  });

  it('checks the schema before a tool runs: missing required, wrong type, enum, array size, with a corrected example', () => {
    const tool = { name: 'demo', parameters: { type: 'object', properties: { kind: { enum: ['a', 'b'] }, count: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' }, minItems: 1 }, note: { type: ['string', 'null'] } }, required: ['kind', 'count'] } };
    expect(checkArguments(tool, { kind: 'c', count: '2', tags: [] })).toEqual([
      { path: 'kind', received: 'a string of 1 characters', expected: 'one of "a", "b"' },
      { path: 'count', received: 'a string of 1 characters', expected: 'an integer' },
      { path: 'tags', received: 'an array of 0 items', expected: 'at least 1 item' },
    ]);
    expect(checkArguments(tool, { note: 'n' }).map((issue) => issue.path)).toEqual(['kind', 'count']);
    expect(checkArguments(tool, { kind: 'a', count: 2, note: null })).toEqual([]);
  });
});

describe('tool_search and tool_load', () => {
  const notes: Tool = { name: 'search_notes', description: 'Search saved notes.', mcp: true, replay: 'safe', sideEffect: false, origin: { connectionId: 'n1', connectionName: 'Notes', toolName: 'search_notes', access: 'read' }, parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, execute: async () => ({ content: [] }) };
  const source = { all: async () => [notes], visible: async () => new Set<string>() };

  it('answers an empty or blank query with the directory of what is hidden, not an error', async () => {
    for (const query of ['', '   ']) {
      const result = await createToolSearchTool(source).execute({ query }, context());
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('Namespace directory');
      expect(textOf(result)).toContain('mcp__notes__*');
    }
  });

  it('requires query: a call without one gets the teaching error', async () => {
    const result = await createToolSearchTool(source).execute({ namespace: 'notes' }, context());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('- query: received nothing (the field is missing); expected a string.');
  });

  it('loads exact names with their schemas, reports a miss, and requires 1 to 10 names', async () => {
    const load = createToolLoadTool(source);
    const text = textOf(await load.execute({ names: ['search_notes', 'ghost'] }, context()));
    expect(text).toContain('Exact tools (1 of 2 found)');
    expect(text).toContain(JSON.stringify(notes.parameters));
    expect(text).toContain('ghost');
    expect((await load.execute({ names: [] }, context())).isError).toBe(true);
    expect((await load.execute({}, context())).isError).toBe(true);
  });
});
