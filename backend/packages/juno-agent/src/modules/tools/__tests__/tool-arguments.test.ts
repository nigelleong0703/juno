import { describe, expect, it } from 'vitest';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createCalendarTools } from '../tools/calendarTools.js';
import { createToolLoadTool, createToolSearchTool } from '../tools/toolSearch.js';
import { createWebSearchTool } from '../tools/webSearch.js';
import { argumentErrorText, checkArguments, decodeJsonText, normalizeOptionalStrings, publicParameters, shownSchema } from '../toolArguments.js';
import { computeRoutesSchema, lookupWeatherSchema } from './grounding-lite-schemas.js';

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

  it('follows local $ref to $defs (the shape Google Maps Grounding Lite sends), and stops on a schema that refers to itself', () => {
    const tool = {
      name: 'route',
      parameters: {
        type: 'object',
        $defs: { Waypoint: { type: 'object', properties: { address: { type: 'string' } } } },
        properties: { origin: { $ref: '#/$defs/Waypoint', description: 'Required. Origin.' }, stops: { type: 'array', items: { $ref: '#/$defs/Waypoint' } } },
        required: ['origin'],
      },
    };
    expect(checkArguments(tool, { origin: { address: 'A' }, stops: [{ address: 'B' }] })).toEqual([]);
    const issues = checkArguments(tool, { origin: '{"address": "A"}', stops: ['B'] });
    expect(issues.map((issue) => [issue.path, issue.expected])).toEqual([['origin', 'an object'], ['stops[0]', 'an object']]);
    expect(issues[0]?.received).toContain('a string of JSON text');

    const message = argumentErrorText({ name: 'maps_routes', parameters: computeRoutesSchema }, checkArguments({ parameters: computeRoutesSchema }, { origin: '{"address":"A"}', destination: { address: 'B' } }));
    expect(message).toContain('- origin: received a string of JSON text');
    expect(message).toContain('Corrected example: {"origin":{"address":"<address>"},"destination":{"address":"<address>"}}');
    expect(message).toContain('Nothing was run. Correct the arguments and call maps_routes again.');

    const either = { name: 'either', parameters: { type: 'object', properties: { place: { oneOf: [{ type: 'object', properties: { address: { type: 'string' } } }, { type: 'object', properties: { placeId: { type: 'string' } } }] }, loose: { anyOf: [{ type: 'string' }, { properties: {} }] } } } };
    expect(checkArguments(either, { place: { placeId: 'p' }, loose: 5 })).toEqual([]);
    expect(checkArguments(either, { place: '{"address":"A"}' }).map((issue) => [issue.path, issue.expected])).toEqual([['place', 'an object']]);

    const tree = { type: 'object', $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } }, properties: { root: { $ref: '#/$defs/Node' } } };
    expect(checkArguments({ parameters: tree }, { root: { child: { child: 'x' } } })).toEqual([{ path: 'root.child.child', received: 'a string of 1 characters', expected: 'an object' }]);
  });
});

describe('the schema the model is shown for a server tool', () => {
  it('writes the Grounding Lite references out: origin and destination are objects with address / latLng / placeId, and $defs is gone', () => {
    const shown = shownSchema(computeRoutesSchema);
    const origin = (shown['properties'] as Record<string, Record<string, unknown>>)['origin'];
    expect(origin?.['type']).toBe('object');
    expect(Object.keys(origin?.['properties'] as object)).toEqual(['address', 'latLng', 'placeId']);
    expect((origin?.['properties'] as Record<string, Record<string, unknown>>)['latLng']?.['type']).toBe('object');
    expect(JSON.stringify(shown)).not.toContain('$ref');
    expect(shown['$defs']).toBeUndefined();
    expect(shown['required']).toEqual(['origin', 'destination']);
    // The server's own schema is not changed: checking and calling use it.
    expect(computeRoutesSchema.properties.origin).toEqual({ $ref: '#/$defs/Waypoint' });
    const weather = shownSchema(lookupWeatherSchema);
    expect((weather['properties'] as Record<string, Record<string, unknown>>)['date']?.['type']).toBe('object');
  });

  it('keeps $defs when a reference could not be written out', () => {
    const tree = { type: 'object', $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } }, properties: { root: { $ref: '#/$defs/Node' } } };
    expect(shownSchema(tree)['$defs']).toBeDefined();
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

describe('objects and arrays sent as JSON text', () => {
  const parameters = {
    type: 'object',
    $defs: { Waypoint: { type: 'object', properties: { address: { type: 'string' } } } },
    properties: {
      note: { type: 'string' },
      origin: { $ref: '#/$defs/Waypoint' },
      stops: { type: 'array', items: { type: 'object', properties: { at: { $ref: '#/$defs/Waypoint' } } } },
      place: { oneOf: [{ type: 'object', properties: { address: { type: 'string' } } }, { type: 'object', properties: { placeId: { type: 'string' } } }] },
      loose: { anyOf: [{ type: 'string' }, { type: 'object' }] },
    },
  };

  it('decodes a field whose schema is an object or array, at any depth and through $ref/oneOf, and says which', () => {
    const { args, normalized } = decodeJsonText(parameters, { origin: '{"address":"A"}', stops: '[{"at":"{\\"address\\":\\"B\\"}"}]', place: ' {"placeId":"p"} ' });
    expect(args).toEqual({ origin: { address: 'A' }, stops: [{ at: { address: 'B' } }], place: { placeId: 'p' } });
    expect(normalized.map((entry) => entry.field)).toEqual(['origin', 'stops', 'stops[0].at', 'place']);
  });

  it('leaves a string field holding JSON, text of the wrong shape and broken JSON for the check to name', () => {
    const sent = { note: '{"a":1}', loose: '{"a":1}', origin: '["A"]', place: '{"address":' };
    const { args, normalized } = decodeJsonText(parameters, sent);
    expect(args).toBe(sent);
    expect(normalized).toEqual([]);
    expect(checkArguments({ parameters }, args).map((issue) => issue.path)).toEqual(['origin', 'place']);
  });
});
