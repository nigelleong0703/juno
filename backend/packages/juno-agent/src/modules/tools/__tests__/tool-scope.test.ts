/**
 * Tool availability by context (batch 5b): what each scope is offered, the refusal at the call, file paths outside the chat's own
 * folder, `calendar_free_busy` (busy times only), the card's notice on a send to someone else, and the scope a conversation keeps.
 */
import { describe, expect, it } from 'vitest';
import type { Tool, ToolContext, ToolOrigin, ToolRegistry, ToolResult } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { metaOf } from '../../../execution/brain/context-notes.js';
import { draftNoticeOf, evaluateToolPolicy, scopeToolsFor, type ToolPolicyConfig } from '../../../execution/harness/services/tool-policy.js';
import type { RunServices } from '../../../execution/harness/services/run-types.js';
import { chatFolder } from '../../chat-folder.js';
import { busyOf, createCalendarFreeBusyTool } from '../tools/calendarFreeBusy.js';
import { harnessToolView } from '../harness-view.js';
import { activeHarnessVersion } from '../../harness/loader.js';
import { createSendMessageTool } from '../tools/sendMessage.js';
import { createMacAppsTools } from '../tools/macApps.js';
import {
  DRAFT_NOTICE, OUTSIDE_CHAT_FOLDER, WRITE_FOR_RECIPIENT, hiddenInScope, pathRefusal, readToolScope, resolveToolScope, scopeOfPresence, sendsToOthers,
} from '../scope.js';

const OWN = chatFolder({ id: 'cvn-1', title: 'Friends' });
const OTHER = chatFolder({ id: 'cvn-2', title: 'Work' });

function origin(catalogId: string | undefined, toolName: string, access: ToolOrigin['access'] = 'read', connectionName = 'Connector'): ToolOrigin {
  return { connectionId: 'conn-1', connectionName, toolName, access, ...(catalogId === undefined ? {} : { catalogId }) };
}

function fakeTool(name: string, toolOrigin?: ToolOrigin): Tool {
  return {
    name, description: name, parameters: {}, replay: 'safe', sideEffect: false,
    ...(toolOrigin === undefined ? {} : { origin: toolOrigin }),
    execute: async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'ok' }] }),
  };
}

function policyConfig(scope?: ToolPolicyConfig['scope'], exposed: string[] = ['files.read', 'mac_mail_send', 'calendar_free_busy', 'web_search']): ToolPolicyConfig {
  return { exposed: new Set(exposed), rules: [], plugins: [], disconnectedPluginIds: new Set(), unreadable: false, ...(scope === undefined ? {} : { scope }) };
}

describe('what each scope is offered', () => {
  it('the owner alone is offered every tool except calendar_free_busy', () => {
    for (const name of ['mac_mail_send', 'shell.run', 'computer.click', 'phone_calendar_list_events', 'schedule_list', 'files.read']) {
      expect(hiddenInScope('owner', { name })).toBe(false);
    }
    expect(hiddenInScope('owner', { name: 'calendar_free_busy' })).toBe(true);
  });

  it('a group or a stranger chat loses mail, contacts, shell, desktop, My Mac and calendar tools', () => {
    for (const scope of ['group', 'other'] as const) {
      for (const name of ['mac_mail_search', 'mac_calendar_list_events', 'mac_notes_read', 'shell.run', 'computer.click', 'computer.snapshot', 'computer_copy', 'browser.navigate', 'phone_calendar_list_events', 'phone_reminders_list', 'schedule_list']) {
        expect(hiddenInScope(scope, { name }), `${scope} ${name}`).toBe(true);
      }
      expect(hiddenInScope(scope, { name: 'gmail_search', origin: origin('gmail', 'search_threads') })).toBe(true);
      expect(hiddenInScope(scope, { name: 'outlook_contacts', origin: origin('microsoft-contacts', 'list') })).toBe(true);
      expect(hiddenInScope(scope, { name: 'my_mail', origin: origin(undefined, 'list', 'read', 'Work mail') })).toBe(true);
    }
  });

  it('a group or a stranger chat keeps web, messaging, react, memory and skills, and an unrelated connector', () => {
    for (const name of ['web_search', 'web_fetch', 'send_message', 'react', 'memory_search', 'memory_explain', 'skill_read', 'channel_history']) {
      expect(hiddenInScope('group', { name }), name).toBe(false);
    }
    // A connected app is hidden outside the owner's chat too (batch 5b follow-up): only a catalog entry marked sharedRooms keeps it.
    expect(hiddenInScope('group', { name: 'notion_search', origin: origin('notion', 'search') })).toBe(true);
    expect(hiddenInScope('group', { name: 'notion_search', origin: origin('notion', 'search'), sharedRooms: true })).toBe(false);
  });

  it('calendar_free_busy is offered only where the owner is not alone', () => {
    expect(hiddenInScope('group', { name: 'calendar_free_busy' })).toBe(false);
    expect(hiddenInScope('other', { name: 'calendar_free_busy' })).toBe(false);
    expect(hiddenInScope('owner', { name: 'calendar_free_busy' })).toBe(true);
  });

  it('maps who is present to a scope', () => {
    expect(scopeOfPresence({ kind: 'owner' })).toBe('owner');
    expect(scopeOfPresence({ kind: 'group', groupKey: 'g' })).toBe('group');
    expect(scopeOfPresence({ kind: 'other' })).toBe('other');
  });
});

describe('file paths outside the owner\'s chat', () => {
  it('a group reaches only its own chat folder, on the sandbox', () => {
    expect(pathRefusal('group', 'cvn-1', 'files.read', { path: OWN + '/notes.md' })).toBeUndefined();
    expect(pathRefusal('group', 'cvn-1', 'files.read', { path: OTHER + '/notes.md' })).toBe(OUTSIDE_CHAT_FOLDER);
    expect(pathRefusal('group', 'cvn-1', 'files.read', { path: '/workspace/private.md' })).toBe(OUTSIDE_CHAT_FOLDER);
    expect(pathRefusal('group', 'cvn-1', 'files.search', {})).toBe(OUTSIDE_CHAT_FOLDER);
    expect(pathRefusal('other', 'cvn-1', 'files.write', { path: OWN + '/a.md', on: 'mac' })).toBe(OUTSIDE_CHAT_FOLDER);
  });

  it('the owner alone is not limited, and a tool that takes no path is not a file tool', () => {
    expect(pathRefusal('owner', 'cvn-1', 'files.read', { path: '/workspace/private.md' })).toBeUndefined();
    expect(pathRefusal('group', 'cvn-1', 'web_fetch', { path: '/workspace/private.md' })).toBeUndefined();
  });
});

describe('a send to someone else', () => {
  it('names another room or a recipient, and reads are never sends', () => {
    expect(sendsToOthers('send_message', { kind: 'text', text: 'x', conversationId: 'room-2' }, undefined, 'cvn-1')).toBe(true);
    expect(sendsToOthers('send_message', { kind: 'text', text: 'x', conversationId: 'cvn-1' }, undefined, 'cvn-1')).toBe(false);
    expect(sendsToOthers('send_message', { kind: 'text', text: 'x' }, undefined, 'cvn-1')).toBe(false);
    expect(sendsToOthers('mac_mail_send', { to: ['priya@example.com'], subject: 's', body: 'b' }, undefined, 'cvn-1')).toBe(true);
    expect(sendsToOthers('mac_mail_search', { query: 'priya' }, undefined, 'cvn-1')).toBe(false);
    expect(sendsToOthers('gmail_send', { to: ['a@b.c'] }, origin('gmail', 'send_email', 'action'), 'cvn-1')).toBe(true);
    expect(sendsToOthers('gmail_search', { to: ['a@b.c'] }, origin('gmail', 'search_threads', 'read'), 'cvn-1')).toBe(false);
  });

  it('the card line appears only for an owner-only run sending to someone else', () => {
    const ownerOnly = { scope: { kind: 'owner' as const, conversationId: 'cvn-1' } };
    expect(draftNoticeOf({ ...ownerOnly }, 'mac_mail_send', { to: ['priya@example.com'], subject: 's', body: 'b' })).toBe(DRAFT_NOTICE);
    expect(draftNoticeOf({ ...ownerOnly }, 'mac_mail_search', { query: 'priya' })).toBeUndefined();
    expect(draftNoticeOf({ ...ownerOnly }, 'send_message', { kind: 'text', text: 'x', conversationId: 'cvn-1' })).toBeUndefined();
    expect(draftNoticeOf({ scope: { kind: 'group', conversationId: 'cvn-1' } }, 'mac_mail_send', { to: ['priya@example.com'] })).toBeUndefined();
    expect(draftNoticeOf({}, 'mac_mail_send', { to: ['priya@example.com'] })).toBeUndefined();
  });

  it('the descriptions name the rule in the tools that send content', () => {
    // The model-facing text is the harness unit the tool reads (harness-view.ts); the code keeps no text for it.
    const version = activeHarnessVersion();
    const send = harnessToolView(createSendMessageTool({ store: createMemoryStore(), enqueuer: new NoopEnqueuer() }), version);
    expect(send.description).toContain(WRITE_FOR_RECIPIENT);
    const mail = createMacAppsTools({}).find((tool) => tool.name === 'mac_mail_send');
    expect(mail && harnessToolView(mail, version).description).toContain(WRITE_FOR_RECIPIENT);
  });
});

describe('calendar_free_busy', () => {
  it('keeps only the start and end of each event', () => {
    const answer = [{ id: 'ev-1', title: 'Oncology follow-up at Mercy', location: 'Mercy Hospital', start: '2026-11-06T14:00:00Z', end: '2026-11-06T15:00:00Z', attendees: ['a@b.c'] }];
    expect(busyOf(answer)).toEqual([{ start: '2026-11-06T14:00:00.000Z', end: '2026-11-06T15:00:00.000Z' }]);
    expect(busyOf(JSON.stringify({ timeZone: 'UTC', events: answer }))).toEqual([{ start: '2026-11-06T14:00:00.000Z', end: '2026-11-06T15:00:00.000Z' }]);
    expect(busyOf('not a list of events')).toBeUndefined();
  });

  it('answers from a connected calendar without any title, place or attendee', async () => {
    const calendar = fakeTool('google_calendar_list_events', origin('google-calendar', 'list_events'));
    const answer = { timeZone: 'UTC', events: [{ id: 'ev', title: 'Oncology follow-up at Mercy', location: 'Mercy Hospital', start: '2026-11-06T14:00:00Z', end: '2026-11-06T15:00:00Z' }] };
    calendar.execute = async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
    const tool = createCalendarFreeBusyTool({ store: createMemoryStore(), tools: async () => [calendar] });
    const ctx = { ownerId: 'owner-1', agentId: 'agent-1', conversationId: 'cvn-1', runId: 'run-1', signal: new AbortController().signal, step: async <T>(_name: string, fn: () => Promise<T>) => fn() } as unknown as ToolContext;
    const result = await tool.execute({ from: '2026-11-06T13:00:00Z', to: '2026-11-06T16:00:00Z' }, ctx);
    const shown = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    expect(shown).toContain('2026-11-06T14:00:00.000Z to 2026-11-06T15:00:00.000Z');
    expect(shown).not.toMatch(/Oncology|Mercy|Hospital|location:/i);
  });

  it('says so when no calendar can be read, and refuses a range that ends before it starts', async () => {
    const tool = createCalendarFreeBusyTool({ store: createMemoryStore(), tools: async () => [] });
    const ctx = { ownerId: 'owner-1', agentId: 'agent-1', conversationId: 'cvn-1', runId: 'run-1', signal: new AbortController().signal, step: async <T>(_name: string, fn: () => Promise<T>) => fn() } as unknown as ToolContext;
    const none = await tool.execute({ from: '2026-11-06T13:00:00Z', to: '2026-11-06T16:00:00Z' }, ctx);
    expect(none.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(none)).toContain('No calendar is open to check');
    const backwards = await tool.execute({ from: '2026-11-06T16:00:00Z', to: '2026-11-06T13:00:00Z' }, ctx);
    expect(backwards.isError).toBe(true);
  });
});

describe('refusal at the call and the registry the model is offered', () => {
  it('refuses a hidden tool by name, whatever the frozen list offered', () => {
    const verdict = evaluateToolPolicy(policyConfig({ kind: 'group', conversationId: 'cvn-1' }), 'mac_mail_send', undefined, { to: ['a@b.c'] });
    expect(verdict).toEqual({ kind: 'deny', reason: 'Tool mac_mail_send is not available in this chat, so it was not run' });
    expect(evaluateToolPolicy(policyConfig({ kind: 'owner', conversationId: 'cvn-1' }), 'calendar_free_busy', undefined, {})).toMatchObject({ kind: 'deny' });
  });

  it('refuses a file outside the chat folder in a group, and allows the chat folder', () => {
    const group = policyConfig({ kind: 'group', conversationId: 'cvn-1' });
    expect(evaluateToolPolicy(group, 'files.read', undefined, { path: OTHER + '/notes.md' })).toEqual({ kind: 'deny', reason: OUTSIDE_CHAT_FOLDER });
    expect(evaluateToolPolicy(group, 'files.read', undefined, { path: OWN + '/notes.md' })).toEqual({ kind: 'allow' });
  });

  it('offers a narrowed list to the model and the policy: hidden tools are not in forAgent', async () => {
    const registry: ToolRegistry = {
      forAgent: async () => [fakeTool('web_search'), fakeTool('mac_mail_send'), fakeTool('calendar_free_busy'), fakeTool('files.read')],
      get: () => undefined,
    };
    const services = { toolRegistry: registry } as unknown as RunServices;
    const group = scopeToolsFor(services, 'group').toolRegistry;
    expect((await group.forAgent('agent-1')).map((tool) => tool.name)).toEqual(['web_search', 'calendar_free_busy', 'files.read']);
    const owner = scopeToolsFor(services, 'owner').toolRegistry;
    expect((await owner.forAgent('agent-1')).map((tool) => tool.name)).toEqual(['web_search', 'mac_mail_send', 'files.read']);
  });
});

describe('the scope a conversation keeps', () => {
  it('is decided on the first build and kept after that, whoever is present later', () => {
    expect(resolveToolScope(undefined, undefined, 'group')).toBe('group');
    expect(resolveToolScope('owner', undefined, 'group')).toBe('owner');
    expect(resolveToolScope(undefined, 'other', 'owner')).toBe('other');
  });

  it('reads only the three scopes; a damaged value is absent, not an error', () => {
    expect(readToolScope('owner')).toBe('owner');
    expect(readToolScope('admin')).toBeUndefined();
    expect(readToolScope(7)).toBeUndefined();
    expect(metaOf({ contextMeta: { toolScope: 'group', toolOrder: ['web_search'] } })).toMatchObject({ toolScope: 'group', toolOrder: ['web_search'] });
    expect(metaOf({ contextMeta: { toolScope: 'admin', toolOrder: ['web_search'] } })).toMatchObject({ toolOrder: ['web_search'] });
    expect(metaOf({ contextMeta: { toolScope: 'admin', toolOrder: ['web_search'] } })?.toolScope).toBeUndefined();
  });
});
