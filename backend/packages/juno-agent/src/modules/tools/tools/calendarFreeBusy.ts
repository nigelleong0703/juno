/**
 * `calendar_free_busy {from, to}` (BACKEND 5.3, batch 5b): when the owner is busy in a range, and nothing else. It is offered only
 * where the owner is not alone with the agent (a group, a stranger's chat), in place of the owner's calendar tools. It asks each
 * calendar the owner has, through the same calls those tools make, and keeps only the start and end of each event: no title, place,
 * attendee or note leaves this tool. The sources, each read from its real answer: the iPhone's `calendar.list_events` (a JSON array
 * of events with ISO start and end), the Mac's `calendar_list_events` (text: one line per event starting with its ISO start and end),
 * and a connected Google Calendar's `list_events` (JSON `{events}`). Outlook's list-events answer is text with no structured form, so
 * it is not read.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { callPhone, phoneRefusal } from '../../../execution/phone.js';
import { CALENDAR_FREE_BUSY } from '../scope.js';
import type { ComputerClientProvider } from '../computer/client.js';
import { macUsable } from './macApps.js';
import { invalidArguments } from '../toolArguments.js';

export interface FreeBusyDeps {
  store: Store;
  computer?: ComputerClientProvider;
  /** The tools this agent can use right now: a connected calendar's list-events tool is found among them. */
  tools(agentId: string, signal: AbortSignal): Promise<Tool[]>;
}

/** One busy interval: the only thing a calendar source contributes. */
export interface Busy { start: string; end: string }

const schema = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict();
const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });

/** A time as a timestamp: a string, or an object with a dateTime (the calendar connectors' shape). */
function instantOf(value: unknown): number | undefined {
  const raw = typeof value === 'object' && value !== null ? Reflect.get(value, 'dateTime') : value;
  if (typeof raw !== 'string') return undefined;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : at;
}

/**
 * The busy intervals of a calendar answer: an array of events, or an object with an `events` array; text holding JSON is read as such.
 * Undefined when the answer is not an event list this tool can read (the source then does not count as answered).
 */
export function busyOf(answer: unknown): Busy[] | undefined {
  let data: unknown = answer;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  const events: unknown = Array.isArray(data) ? data : typeof data === 'object' && data !== null ? Reflect.get(data, 'events') : undefined;
  if (!Array.isArray(events)) return undefined;
  const busy: Busy[] = [];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const start = instantOf(Reflect.get(event, 'start'));
    const end = instantOf(Reflect.get(event, 'end'));
    if (start === undefined || end === undefined) continue;
    busy.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  }
  return busy;
}

/** The Mac Calendar's line for one event starts with its ISO start and end (apps/desktop mac-apps.ts); the title comes after. */
const MAC_EVENT_LINE = /^(\d{4}-\d{2}-\d{2}T\S+) to (\d{4}-\d{2}-\d{2}T\S+)/;
const NO_MAC_EVENTS = 'No events in that range';

/** The busy intervals of a Mac Calendar answer; undefined when the text is neither its "no events" line nor an event line. */
export function busyOfMacText(answer: string): Busy[] | undefined {
  if (answer.trim() === NO_MAC_EVENTS) return [];
  const busy: Busy[] = [];
  for (const line of answer.split('\n')) {
    const match = MAC_EVENT_LINE.exec(line);
    if (match === null) continue;
    const start = instantOf(match[1] ?? '');
    const end = instantOf(match[2] ?? '');
    if (start === undefined || end === undefined) continue;
    busy.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  }
  return busy.length === 0 ? undefined : busy;
}

function textOf(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** Most events one answer may list for the iPhone (its schema caps `limit` at 100) and the Mac (50). */
const PHONE_LIMIT = 100;
const MAC_LIMIT = 50;
/** Google pages of events (`maxResults` up to 50), followed through `nextPageToken` up to this many events. */
const GOOGLE_PAGE = 50;
const GOOGLE_EVENT_CAP = 250;

/** One page of a Google list-events answer: its busy intervals, how many events it listed, and the next page's token. */
export function googlePageOf(answer: string): { busy: Busy[]; count: number; next?: string } | undefined {
  let data: unknown;
  try {
    data = JSON.parse(answer);
  } catch {
    return undefined;
  }
  const busy = busyOf(data);
  if (busy === undefined || typeof data !== 'object' || data === null) return undefined;
  const events = Reflect.get(data, 'events');
  const token = Reflect.get(data, 'nextPageToken');
  return { busy, count: Array.isArray(events) ? events.length : 0, ...(typeof token === 'string' && token !== '' ? { next: token } : {}) };
}

/** The busy intervals of one Google Calendar over the range, following its pages up to GOOGLE_EVENT_CAP events; undefined when no page answers. */
async function googleBusy(tool: Tool, ctx: ToolContext, from: string, to: string): Promise<Busy[] | undefined> {
  const busy: Busy[] = [];
  let answered = false;
  let count = 0;
  let pageToken: string | undefined;
  do {
    const result = await tool.execute({ timeMin: from, timeMax: to, maxResults: GOOGLE_PAGE, ...(pageToken === undefined ? {} : { pageToken }) }, ctx);
    const page = result.isError === true ? undefined : googlePageOf(textOf(result));
    if (page === undefined) break;
    answered = true;
    busy.push(...page.busy);
    count += page.count;
    pageToken = page.next;
  } while (pageToken !== undefined && count < GOOGLE_EVENT_CAP);
  return answered ? busy : undefined;
}

/** Each calendar the owner has that answers; undefined when none does. */
async function answersOf(deps: FreeBusyDeps, ctx: ToolContext, from: string, to: string): Promise<Busy[] | undefined> {
  const found: Busy[][] = [];
  if ((await phoneRefusal(deps.store, ctx.ownerId, 'calendar.list_events')) === undefined) {
    const outcome = await callPhone({
      ownerId: ctx.ownerId, agentId: ctx.agentId, callId: `phone_free_${ctx.runId}_${ctx.stepId ?? randomUUID()}`, action: 'calendar.list_events',
      args: { from, to, limit: PHONE_LIMIT }, store: deps.store, signal: ctx.signal,
    });
    const busy = outcome.kind === 'done' && outcome.result.ok ? busyOf(outcome.result.data) : undefined;
    if (busy !== undefined) found.push(busy);
  }
  // The Mac counts only where the owner allowed this agent on it and the paired Mac is online, as for the Mac's own tools.
  const mac = (await macUsable(deps.store, deps.computer, ctx.agentId, ctx.signal)) ? deps.computer?.()?.macApps : undefined;
  if (mac !== undefined) {
    try {
      const busy = busyOfMacText(await mac(ctx.agentId, { tool: 'calendar_list_events', args: { from, to, limit: MAC_LIMIT } }, ctx.signal));
      if (busy !== undefined) found.push(busy);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
    }
  }
  for (const tool of await deps.tools(ctx.agentId, ctx.signal)) {
    const origin = tool.origin;
    // Google Calendar only: its list-events answer is JSON. Outlook's is text with no structured form, so it is not read.
    if (origin === undefined || origin.toolName !== 'list_events' || origin.catalogId !== 'google-calendar') continue;
    const busy = await googleBusy(tool, ctx, from, to);
    if (busy !== undefined) found.push(busy);
  }
  return found.length === 0 ? undefined : found.flat().sort((a, b) => a.start.localeCompare(b.start));
}

export function createCalendarFreeBusyTool(deps: FreeBusyDeps): Tool {
  const tool: Tool = {
    name: CALENDAR_FREE_BUSY,
    description: '',
    parameters: {
      type: 'object',
      properties: { from: { type: 'string', description: '' }, to: { type: 'string', description: '' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return invalidArguments(tool.name, args, parsed.error);
      const { from, to } = parsed.data;
      if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(to) <= Date.parse(from)) {
        return text('from and to must be ISO times, with to after from.', true);
      }
      return ctx.step(tool.name, async (): Promise<ToolResult> => {
        const busy = await answersOf(deps, ctx, from, to);
        if (busy === undefined) return text('No calendar is open to check: the iPhone app is closed, the Mac is not connected and no calendar is connected. Offer to ask the owner.');
        if (busy.length === 0) return text(`No busy time from ${from} to ${to} on the calendars checked. (Busy times only: no titles, places or attendees.)`);
        return text(`Busy times between ${from} and ${to}:\n${busy.map((item) => `${item.start} to ${item.end}`).join('\n')}\n(Busy times only: no titles, places or attendees.)`);
      });
    },
  };
  return tool;
}
