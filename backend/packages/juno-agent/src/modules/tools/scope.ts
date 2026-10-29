/**
 * Tool availability by context (BACKEND 5.3, batch 5b). Who is in a conversation decides which tools the agent is offered:
 * `owner` (the owner alone with the agent), `group` (a platform group or room, whoever speaks) or `other` (a stranger's chat,
 * the same as a group). The scope is decided once per conversation, on its first context build, and frozen in the system row
 * (`contextMeta.toolScope`, next to `toolOrder`): the tool array is part of the cached prefix. The policy re-reads who is present
 * at every call and refuses a hidden tool, so a stale scope still cannot be used.
 */
import type { Presence } from '@agent-desktop/memory-graph/memory';
import type { Store, Tool, ToolOrigin, WakeEvent } from '../../contracts/index.js';
import { chatHash, chatHashOfPath } from '../chat-folder.js';
import { presenceOf } from '../memory/presence.js';

export const TOOL_SCOPES = ['owner', 'group', 'other'] as const;
export type ToolScope = (typeof TOOL_SCOPES)[number];

export const CALENDAR_FREE_BUSY = 'calendar_free_busy';

export function scopeOfPresence(presence: Presence): ToolScope {
  return presence.kind === 'owner' ? 'owner' : presence.kind === 'group' ? 'group' : 'other';
}

/** Who is present in a conversation now, as a tool scope (the live scope; a conversation's frozen scope is read from its row). */
export async function presentToolScope(store: Store, run: { ownerId: string | undefined; agentId: string; conversationId: string; wake: Array<Pick<WakeEvent, 'ownerId' | 'origin' | 'trusted'>> }): Promise<ToolScope> {
  return scopeOfPresence(await presenceOf(store, run));
}

/** A stored scope value, or undefined for anything else (an older row, a damaged one). */
export function readToolScope(value: unknown): ToolScope | undefined {
  return typeof value === 'string' && (TOOL_SCOPES as readonly string[]).includes(value) ? (value as ToolScope) : undefined;
}

/** The scope a conversation keeps: the one its frozen row recorded, else the one its last build had, else who is present now. */
export function resolveToolScope(stored: ToolScope | undefined, previous: ToolScope | undefined, present: ToolScope): ToolScope {
  return stored ?? previous ?? present;
}

/**
 * Native tools hidden outside the owner's own chat, by name prefix: the shell, the sandbox and the Mac's desktop, browser
 * sessions (signed in as the owner), the Mac's apps (mail, calendar, reminders, notes), the iPhone's calendar and reminders, and the
 * owner's documents (BACKEND 5.11a).
 */
const HIDDEN_OUTSIDE_OWNER: readonly string[] = ['shell.', 'computer.', 'computer_', 'browser.', 'mac_', 'phone_calendar_', 'phone_reminders_', 'document_'];

/** The agent's own schedule: reading it shows the owner's plans, so it stays with the owner. Scheduling (`schedule_add`) is open in a group. */
const SCHEDULE_READ_TOOLS: ReadonlySet<string> = new Set(['schedule_list', 'schedule_get']);
/** Changing an item of the schedule: outside the owner's chat only an item this chat made (its record names the conversation). */
export const SCHEDULE_CHANGE_TOOLS: ReadonlySet<string> = new Set(['schedule_update', 'schedule_cancel']);

/** A connected app's tool: served by a connection (an MCP server, a catalog connector) or added by a host plugin. */
function isConnectedApp(tool: Pick<Tool, 'origin' | 'mcp' | 'plugin'>): boolean {
  return tool.origin !== undefined || tool.mcp === true || tool.plugin === true;
}

/**
 * Whether a tool is offered in a scope. The owner's own chat offers every tool. Elsewhere a connected app's tool is hidden, since it
 * reaches the owner's data (Gmail, Notion, Drive alike), unless its catalog entry is marked `sharedRooms`; `calendar_free_busy` is
 * offered only elsewhere.
 */
export function hiddenInScope(scope: ToolScope, tool: Pick<Tool, 'name' | 'origin' | 'mcp' | 'plugin' | 'sharedRooms'>): boolean {
  if (tool.name === CALENDAR_FREE_BUSY) return scope === 'owner';
  if (scope === 'owner') return false;
  if (SCHEDULE_READ_TOOLS.has(tool.name)) return true;
  if (HIDDEN_OUTSIDE_OWNER.some((prefix) => tool.name.startsWith(prefix))) return true;
  return isConnectedApp(tool) && tool.sharedRooms !== true;
}

/** The tools of a list that a scope offers: discovery, tool search, the disclosure note and the policy's list all use this one filter. */
export function offeredIn<T extends Pick<Tool, 'name' | 'origin'>>(scope: ToolScope | undefined, tools: readonly T[]): T[] {
  return tools.filter((tool) => !hiddenInScope(scope ?? 'owner', tool));
}

export const OTHER_CHAT_SCHEDULE = "Outside the owner's chat only the schedule items made in this chat can be changed";

/** Why a schedule change is refused in this scope (undefined when allowed): `sameChat` is whether the item was made in this chat. */
export function scheduleRefusal(scope: ToolScope, toolName: string, sameChat: boolean): string | undefined {
  if (scope === 'owner' || !SCHEDULE_CHANGE_TOOLS.has(toolName) || sameChat) return undefined;
  return OTHER_CHAT_SCHEDULE;
}

/** Tools that read or write a file by its path: outside the owner's own chat they reach only that chat's folder. */
export function isPathTool(name: string): boolean {
  return name.startsWith('files.') || name === 'send_file' || name === 'space_publish' || name === 'artifact_publish';
}

export function pathOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const value: unknown = Reflect.get(args, 'path');
  return typeof value === 'string' ? value.trim() : '';
}

export function onMac(args: unknown): boolean {
  return typeof args === 'object' && args !== null && Reflect.get(args, 'on') === 'mac';
}

export const OUTSIDE_CHAT_FOLDER = "Files outside this chat's own folder are not available in a group or a stranger's chat";

/** Why a call's file path is refused in this scope (undefined when allowed): only the chat's own folder, on the sandbox, outside the owner's chat. */
export function pathRefusal(scope: ToolScope, conversationId: string, toolName: string, args: unknown): string | undefined {
  if (scope === 'owner' || !isPathTool(toolName)) return undefined;
  const path = pathOf(args);
  if (!onMac(args) && path !== '' && chatHashOfPath(path) === chatHash(conversationId)) return undefined;
  return OUTSIDE_CHAT_FOLDER;
}

const RECIPIENT_KEYS: readonly string[] = ['to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'address', 'channel', 'chat_id'];

/** The recipients a call names (lower-cased, trimmed): the argument keys that say who a call sends to. */
export function recipientsOf(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return [];
  const found: string[] = [];
  for (const key of RECIPIENT_KEYS) {
    const value: unknown = Reflect.get(args, key);
    if (typeof value === 'string') found.push(value);
    if (Array.isArray(value)) found.push(...value.filter((entry): entry is string => typeof entry === 'string'));
  }
  return found.map((recipient) => recipient.trim().toLowerCase()).filter((recipient) => recipient !== '');
}

/**
 * Whether a call sends what it writes to someone other than the owner: a message to another chat or room, a post to a room, a
 * connector action naming recipients, or a Mac mail send or draft to recipients. Reads are never sends.
 */
export function sendsToOthers(toolName: string, args: unknown, origin: ToolOrigin | undefined, conversationId: string): boolean {
  if (toolName === 'send_message') {
    const target = typeof args === 'object' && args !== null ? Reflect.get(args, 'conversationId') : undefined;
    return typeof target === 'string' && target.trim() !== '' && target !== conversationId;
  }
  if (toolName === 'post_to_room') return true;
  const sends = origin?.access === 'action' || toolName === 'mac_mail_send' || toolName === 'mac_mail_create_draft';
  return sends && recipientsOf(args).length > 0;
}

/** The sentence the tools that send to someone else carry in their descriptions (owner runs). */
export const WRITE_FOR_RECIPIENT = "Write only what this recipient may know: e.g. say you're away 6–9 Nov, not where or why; never include health, money or private plans unless the person you help asked you to share them.";

/** The line the approval card of such a send carries when the run is owner-only and the recipient is not the owner. */
export const DRAFT_NOTICE = 'Drafted with your private memory in view — check nothing private is included';
