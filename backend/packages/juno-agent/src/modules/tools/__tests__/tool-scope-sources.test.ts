/**
 * Batch 5b follow-up: the calendar sources read their real answers (the Mac's text lines, Google's JSON; the iPhone's JSON array is
 * covered in tool-scope.test.ts; Outlook is not read), schedule tools by scope (reads hidden; a change only for this chat's items),
 * and discovery (tool_search, tool_load) offering only what the scope allows.
 */
import { describe, expect, it } from 'vitest';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { evaluateToolPolicy, type ToolPolicyConfig } from '../../../execution/harness/services/tool-policy.js';
import { createToolRegistry } from '../index.js';
import { TOOL_LOAD, TOOL_SEARCH, toolsForModel } from '../tools/toolSearch.js';
import { busyOfMacText, createCalendarFreeBusyTool } from '../tools/calendarFreeBusy.js';
import { createMonitorCreateTool } from '../tools/monitorTools.js';
import { BUILTIN_CATALOG_ENTRIES, sharedRoomCatalogIds } from '../../mcp/catalog.js';
import { OTHER_CHAT_SCHEDULE, hiddenInScope, offeredIn, scheduleRefusal, type ToolScope } from '../scope.js';

const text = (result: ToolResult): string => result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

function ctxOf(store: ReturnType<typeof createMemoryStore>, scope?: ToolScope): ToolContext {
  return {
    ownerId: 'owner-1', agentId: 'agent-1', conversationId: 'cvn-1', runId: 'run-1', store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: { id: 'wake-1', ownerId: 'owner-1', agentId: 'agent-1', sessionKey: 'agent-1:cvn-1', conversationId: 'cvn-1', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'go' }, at: '2026-10-26T00:00:00.000Z', status: 'accepted' },
    step: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    signal: new AbortController().signal,
    ...(scope === undefined ? {} : { toolScope: scope }),
  } as unknown as ToolContext;
}

function connector(name: string, catalogId: string, answer: () => Promise<ToolResult>): Tool {
  return {
    name, description: 'Search ' + name, parameters: {}, replay: 'safe', sideEffect: false,
    origin: { connectionId: 'conn-' + catalogId, connectionName: catalogId, catalogId, toolName: 'list_events', access: 'read' },
    execute: answer,
  };
}

describe('calendar sources read their real answers', () => {
  it('the Mac Calendar line starts with the ISO start and end: the title and place are dropped', () => {
    const answer = [
      '2026-11-06T14:00:00+00:00 to 2026-11-06T15:00:00+00:00  Oncology follow-up at Mercy [Personal]  Mercy Hospital',
      '2026-11-06T16:00:00+00:00 to 2026-11-06T16:30:00+00:00 (all day)  Team sync [Work]',
    ].join('\n');
    expect(busyOfMacText(answer)).toEqual([
      { start: '2026-11-06T14:00:00.000Z', end: '2026-11-06T15:00:00.000Z' },
      { start: '2026-11-06T16:00:00.000Z', end: '2026-11-06T16:30:00.000Z' },
    ]);
    expect(busyOfMacText('No events in that range')).toEqual([]);
    expect(busyOfMacText('osascript: something unexpected')).toBeUndefined();
  });

  it('reads the Mac when it is usable: busy times only, no title or place', async () => {
    const store = createMemoryStore();
    await store.put('agents', { id: 'agent-1', ownerId: 'owner-1', macAccess: true, name: 'Nova' } as never);
    const computer = () => ({
      macStatus: async () => ({ paired: true, online: true }),
      macApps: async () => '2026-11-06T14:00:00+00:00 to 2026-11-06T15:00:00+00:00  Oncology follow-up [Personal]  Mercy Hospital',
    });
    const tool = createCalendarFreeBusyTool({ store, computer: computer as never, tools: async () => [] });
    const shown = text(await tool.execute({ from: '2026-11-06T13:00:00Z', to: '2026-11-06T16:00:00Z' }, ctxOf(store, 'group')));
    expect(shown).toContain('2026-11-06T14:00:00.000Z to 2026-11-06T15:00:00.000Z');
    expect(shown).not.toMatch(/Oncology|Mercy|Hospital/i);
  });

  it('reads Google Calendar JSON, and never calls Outlook (its answer is text with no structured form)', async () => {
    const store = createMemoryStore();
    const google = connector('google_calendar_list_events', 'google-calendar', async () => ({
      content: [{ type: 'text', text: JSON.stringify({ timeZone: 'UTC', events: [{ id: 'g1', title: 'Dentist', location: 'Clinic', start: '2026-11-06T14:00:00Z', end: '2026-11-06T15:00:00Z' }] }) }],
    }));
    let outlookCalls = 0;
    const outlook = connector('outlook_calendar_list_events', 'outlook-calendar', async () => {
      outlookCalls += 1;
      return { content: [{ type: 'text', text: '[AAMk] 2026-11-06 14:00 to 15:00 | Board' }] };
    });
    const tool = createCalendarFreeBusyTool({ store, tools: async () => [google, outlook] });
    const shown = text(await tool.execute({ from: '2026-11-06T13:00:00Z', to: '2026-11-06T16:00:00Z' }, ctxOf(store, 'group')));
    expect(shown).toContain('2026-11-06T14:00:00.000Z to 2026-11-06T15:00:00.000Z');
    expect(shown).not.toMatch(/Dentist|Clinic|Board/);
    expect(outlookCalls).toBe(0);
  });
});

describe('schedule tools by scope', () => {
  it('a group reads no schedule (list, get) but may add, and changes only items made in its own chat', () => {
    expect(hiddenInScope('group', { name: 'schedule_list' })).toBe(true);
    expect(hiddenInScope('group', { name: 'schedule_get' })).toBe(true);
    expect(hiddenInScope('group', { name: 'schedule_add' })).toBe(false);
    expect(hiddenInScope('group', { name: 'schedule_update' })).toBe(false);
    expect(hiddenInScope('group', { name: 'schedule_cancel' })).toBe(false);
    expect(scheduleRefusal('group', 'schedule_update', false)).toBe(OTHER_CHAT_SCHEDULE);
    expect(scheduleRefusal('group', 'schedule_cancel', true)).toBeUndefined();
    expect(scheduleRefusal('group', 'schedule_add', false)).toBeUndefined();
    expect(scheduleRefusal('owner', 'schedule_update', false)).toBeUndefined();
  });

  it('the policy refuses a change to another chat\'s item and allows a reminder for this chat', () => {
    const config = (scheduleOwn: boolean): ToolPolicyConfig => ({
      exposed: new Set(['schedule_add', 'schedule_update']), rules: [], plugins: [], disconnectedPluginIds: new Set(), unreadable: false,
      scope: { kind: 'group', conversationId: 'cvn-1', scheduleOwn },
    });
    expect(evaluateToolPolicy(config(false), 'schedule_update', undefined, { id: 'cal-1' })).toEqual({ kind: 'deny', reason: OTHER_CHAT_SCHEDULE + ', so it was not run' });
    expect(evaluateToolPolicy(config(true), 'schedule_update', undefined, { id: 'cal-1' })).toEqual({ kind: 'allow' });
    expect(evaluateToolPolicy(config(false), 'schedule_add', undefined, { title: 'Call back' })).toEqual({ kind: 'allow' });
  });
});

describe('connected apps stay with the owner', () => {
  const notion: Tool = connector('notion_search', 'notion', async () => ({ content: [{ type: 'text', text: 'pages' }] }));

  it('a connector, MCP or plugin tool is hidden in a group or a stranger chat unless its catalog entry is marked sharedRooms', () => {
    expect(hiddenInScope('group', notion)).toBe(true);
    expect(hiddenInScope('other', { name: 'linear_list', mcp: true })).toBe(true);
    expect(hiddenInScope('group', { name: 'meeting_list', plugin: true })).toBe(true);
    expect(hiddenInScope('group', { ...notion, sharedRooms: true })).toBe(false);
    expect(hiddenInScope('owner', notion)).toBe(false);
  });

  it('no catalog entry is marked sharedRooms yet, and a marked id is picked up', () => {
    expect(sharedRoomCatalogIds(BUILTIN_CATALOG_ENTRIES).size).toBe(0);
    const first = BUILTIN_CATALOG_ENTRIES[0];
    if (first === undefined) throw new Error('the catalog has no entries');
    expect(sharedRoomCatalogIds([{ ...first, sharedRooms: true }]).has(first.id)).toBe(true);
  });

  it('monitor_create cannot watch a connected app from a group: the tool is not offered there', async () => {
    const store = createMemoryStore();
    await store.put('agents', { id: 'agent-1', ownerId: 'owner-1', name: 'Nova' } as never);
    await store.put('conversations', { id: 'cvn-1', kind: 'direct', memberIds: ['owner-1'], agentIds: ['agent-1'] } as never);
    const monitor = createMonitorCreateTool({ store, enqueuer: new NoopEnqueuer(), tools: { forAgent: async () => [notion] } });
    const args = { name: 'Notion pages', tool: 'notion_search', prompt: 'Tell me about new pages', everyMinutes: 60 };
    const grouped = await monitor.execute(args, ctxOf(store, 'group'));
    expect(grouped.isError).toBe(true);
    expect(text(grouped)).toContain('is not available');
    expect((await store.list('routines', { limit: 5 })).items).toHaveLength(0);
    const owned = await monitor.execute(args, ctxOf(store, 'owner'));
    expect(text(owned)).not.toContain('is not available');
  });
});

describe('calendar_free_busy is shown to the model in a group', () => {
  it('the tool is in the list the model sees, not behind tool_search', () => {
    const store = createMemoryStore();
    const tool = createCalendarFreeBusyTool({ store, tools: async () => [] });
    // The registry leaves a core tool undeferred; the model's list keeps it as shown.
    const shown = toolsForModel([tool], {}, {});
    expect(shown.map((candidate) => candidate.name)).toContain('calendar_free_busy');
    expect(shown.find((candidate) => candidate.name === 'calendar_free_busy')?.deferLoading).not.toBe(true);
  });
});

describe('calendar reads ask for the full pages', () => {
  it('Google: follows nextPageToken and reads the events of every page', async () => {
    const store = createMemoryStore();
    const calls: Array<Record<string, unknown>> = [];
    const pages: Record<string, string> = {
      '': JSON.stringify({ timeZone: 'UTC', events: [{ id: 'a', title: 'First', start: '2026-11-06T14:00:00Z', end: '2026-11-06T15:00:00Z' }], nextPageToken: 'p2' }),
      p2: JSON.stringify({ timeZone: 'UTC', events: [{ id: 'b', title: 'Second', start: '2026-11-06T16:00:00Z', end: '2026-11-06T16:30:00Z' }] }),
    };
    const google = connector('google_calendar_list_events', 'google-calendar', async () => ({ content: [] }));
    google.execute = async (args: unknown): Promise<ToolResult> => {
      const input = args as Record<string, unknown>;
      calls.push(input);
      return { content: [{ type: 'text', text: pages[String(input['pageToken'] ?? '')] ?? '{}' }] };
    };
    const tool = createCalendarFreeBusyTool({ store, tools: async () => [google] });
    const shown = text(await tool.execute({ from: '2026-11-06T13:00:00Z', to: '2026-11-06T17:00:00Z' }, ctxOf(store, 'group')));
    expect(shown).toContain('2026-11-06T14:00:00.000Z to 2026-11-06T15:00:00.000Z');
    expect(shown).toContain('2026-11-06T16:00:00.000Z to 2026-11-06T16:30:00.000Z');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ maxResults: 50 });
    expect(calls[1]).toMatchObject({ pageToken: 'p2' });
  });

  it('the Mac is asked for its largest answer (50 events)', async () => {
    const store = createMemoryStore();
    await store.put('agents', { id: 'agent-1', ownerId: 'owner-1', macAccess: true, name: 'Nova' } as never);
    let asked: Record<string, unknown> = {};
    const computer = () => ({
      macStatus: async () => ({ paired: true, online: true }),
      macApps: async (_agent: string, input: { args: Record<string, unknown> }) => {
        asked = input.args;
        return 'No events in that range';
      },
    });
    const tool = createCalendarFreeBusyTool({ store, computer: computer as never, tools: async () => [] });
    await tool.execute({ from: '2026-11-06T13:00:00Z', to: '2026-11-06T16:00:00Z' }, ctxOf(store, 'group'));
    expect(asked).toMatchObject({ limit: 50 });
  });
});

describe('discovery offers only what the scope allows', () => {
  it('tool_search and tool_load do not show a hidden tool by name in a group, and show it to the owner alone', async () => {
    const store = createMemoryStore();
    const privateSearch = connector('gmail_search_threads', 'gmail', async () => ({ content: [{ type: 'text', text: 'never' }] }));
    privateSearch.description = 'Search gmail threads for the owner';
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), pluginTools: [{ tool: privateSearch }] });
    const search = registry.get(TOOL_SEARCH);
    const load = registry.get(TOOL_LOAD);
    if (search === undefined || load === undefined) throw new Error('discovery tools missing');

    const inGroup = text(await search.execute({ query: 'gmail threads' }, ctxOf(store, 'group')));
    const forOwner = text(await search.execute({ query: 'gmail threads' }, ctxOf(store, 'owner')));
    expect(inGroup).not.toContain('gmail_search_threads');
    expect(forOwner).toContain('gmail_search_threads');

    const loadedInGroup = text(await load.execute({ names: ['gmail_search_threads'] }, ctxOf(store, 'group')));
    expect(loadedInGroup).not.toContain('Search gmail threads for the owner');

    const freeBusyInGroup = text(await search.execute({ query: 'calendar free busy' }, ctxOf(store, 'group')));
    const freeBusyForOwner = text(await search.execute({ query: 'calendar free busy' }, ctxOf(store, 'owner')));
    expect(freeBusyInGroup).toContain('calendar_free_busy');
    expect(freeBusyForOwner).not.toContain('calendar_free_busy');
  });

  it('the scope filter is the one the list and the policy use', () => {
    const tools = [{ name: 'web_search' }, { name: 'shell.run' }, { name: 'calendar_free_busy' }] as Array<{ name: string; origin?: undefined }>;
    expect(offeredIn('group', tools).map((tool) => tool.name)).toEqual(['web_search', 'calendar_free_busy']);
    expect(offeredIn('owner', tools).map((tool) => tool.name)).toEqual(['web_search', 'shell.run']);
    expect(offeredIn(undefined, tools).map((tool) => tool.name)).toEqual(['web_search', 'shell.run']);
  });
});
