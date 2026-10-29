/**
 * Calendar and Reminders on the owner's iPhone (BACKEND 7.13). The iPhone app runs them through EventKit while it is open and
 * connected; here each tool only names the call. Reads are free; creating or changing asks the owner (committing), deleting and
 * changing a whole recurring series asks as irreversible. A write is never retried: when the phone does not answer in time the
 * agent is told it may or may not have been applied, and reads to check.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { PhoneCallAction } from '@agent-desktop/public-contracts';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { callPhone, phoneRefusal } from '../../../execution/phone.js';

/** The tools that change something: policy asks first for each. */
export const PHONE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'phone_calendar_create_event', 'phone_calendar_update_event', 'phone_calendar_delete_event',
  'phone_reminders_create', 'phone_reminders_update', 'phone_reminders_delete',
]);
/** Every tool of this unit. */
export const PHONE_TOOLS: ReadonlySet<string> = new Set([
  'phone_calendar_list_calendars', 'phone_calendar_list_events', 'phone_reminders_list', ...PHONE_WRITE_TOOLS,
]);

/** Largest answer text handed to the model. */
const MAX_TEXT = 20_000;

const cap = (max: number) => z.number().int().positive().max(max).optional();
const span = z.enum(['this', 'future']).optional();

interface Def {
  name: string;
  call: PhoneCallAction;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  schema: z.ZodType<Record<string, unknown>>;
}

const SPAN = { enum: ['this', 'future'], description: '' };

const DEFS: readonly Def[] = [
  {
    name: 'phone_calendar_list_calendars', call: 'calendar.list_calendars',
    description: '',
    properties: {}, schema: z.object({}).strict(),
  },
  {
    name: 'phone_calendar_list_events', call: 'calendar.list_events',
    description: '',
    properties: { from: { type: 'string', description: '' }, to: { type: 'string', description: '' }, calendar: { type: 'string', description: '' }, limit: { type: 'number', description: '' } },
    required: ['from', 'to'], schema: z.object({ from: z.string().min(1), to: z.string().min(1), calendar: z.string().optional(), limit: cap(100) }).strict(),
  },
  {
    name: 'phone_calendar_create_event', call: 'calendar.create_event',
    description: '',
    properties: { title: { type: 'string' }, start: { type: 'string', description: '' }, end: { type: 'string', description: '' }, allDay: { type: 'boolean' }, calendar: { type: 'string', description: '' }, location: { type: 'string' }, notes: { type: 'string' } },
    required: ['title', 'start', 'end'],
    schema: z.object({ title: z.string().min(1).max(300), start: z.string().min(1), end: z.string().min(1), allDay: z.boolean().optional(), calendar: z.string().optional(), location: z.string().max(300).optional(), notes: z.string().max(4000).optional() }).strict(),
  },
  {
    name: 'phone_calendar_update_event', call: 'calendar.update_event',
    description: '',
    properties: { id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string', description: '' }, end: { type: 'string', description: '' }, location: { type: 'string' }, notes: { type: 'string' }, span: SPAN },
    required: ['id'],
    schema: z.object({ id: z.string().min(1), title: z.string().min(1).max(300).optional(), start: z.string().min(1).optional(), end: z.string().min(1).optional(), location: z.string().max(300).optional(), notes: z.string().max(4000).optional(), span }).strict(),
  },
  {
    name: 'phone_calendar_delete_event', call: 'calendar.delete_event',
    description: '',
    properties: { id: { type: 'string' }, span: SPAN }, required: ['id'], schema: z.object({ id: z.string().min(1), span }).strict(),
  },
  {
    name: 'phone_reminders_list', call: 'reminders.list',
    description: '',
    properties: { list: { type: 'string', description: '' }, includeCompleted: { type: 'boolean' }, limit: { type: 'number', description: '' } },
    schema: z.object({ list: z.string().optional(), includeCompleted: z.boolean().optional(), limit: cap(100) }).strict(),
  },
  {
    name: 'phone_reminders_create', call: 'reminders.create',
    description: '',
    properties: { title: { type: 'string' }, list: { type: 'string', description: '' }, due: { type: 'string', description: '' }, notes: { type: 'string' } },
    required: ['title'], schema: z.object({ title: z.string().min(1).max(300), list: z.string().optional(), due: z.string().min(1).optional(), notes: z.string().max(4000).optional() }).strict(),
  },
  {
    name: 'phone_reminders_update', call: 'reminders.update',
    description: '',
    properties: { id: { type: 'string' }, title: { type: 'string' }, due: { type: 'string', description: '' }, notes: { type: 'string' }, completed: { type: 'boolean' } },
    required: ['id'], schema: z.object({ id: z.string().min(1), title: z.string().min(1).max(300).optional(), due: z.string().min(1).optional(), notes: z.string().max(4000).optional(), completed: z.boolean().optional() }).strict(),
  },
  {
    name: 'phone_reminders_delete', call: 'reminders.delete',
    description: '',
    properties: { id: { type: 'string' } }, required: ['id'], schema: z.object({ id: z.string().min(1) }).strict(),
  },
];

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '\n(cut off)' : value }], ...(isError ? { isError } : {}) });

export function createPhoneTools(): Tool[] {
  return DEFS.map((def): Tool => {
    const writes = PHONE_WRITE_TOOLS.has(def.name);
    return {
      name: def.name,
      description: def.description,
      parameters: { type: 'object', properties: def.properties, ...(def.required === undefined ? {} : { required: def.required }), additionalProperties: false },
      replay: writes ? 'never' : 'safe',
      sideEffect: writes,
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const parsed = def.schema.safeParse(args ?? {});
        if (!parsed.success) return invalidArguments(def.name, args, parsed.error);
        // The phone's own declaration decides, at the moment of the call: the app may have closed since the tool was found.
        const refusal = await phoneRefusal(ctx.store, ctx.ownerId, def.call);
        if (refusal !== undefined) return text(refusal, true);
        return ctx.step(def.name, async (): Promise<ToolResult> => {
          // The id is the same when this step is run again after a crash, so the phone answers it from what it already did.
          const callId = `phone_${ctx.runId}_${ctx.stepId ?? randomUUID()}`;
          const outcome = await callPhone({ ownerId: ctx.ownerId, agentId: ctx.agentId, callId, action: def.call, args: parsed.data, store: ctx.store, signal: ctx.signal });
          if (outcome.kind === 'done') {
            return outcome.result.ok
              ? text(typeof outcome.result.data === 'string' ? outcome.result.data : JSON.stringify(outcome.result.data ?? null))
              : text(outcome.result.error, true);
          }
          const why = outcome.kind === 'timeout' ? "The iPhone didn't answer within 20 seconds" : 'The iPhone app disconnected before it answered';
          return writes
            ? text(`${why}, so this change may or may not have been applied. Do not repeat it: read the calendar or reminders first to check, then decide.`, true)
            : text(`${why}. Nothing changed. Ask the owner to open Juno on their phone if you still need it.`, true);
        });
      },
    };
  });
}
