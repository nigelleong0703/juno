/**
 * Reminders on the iPhone (EventKit). Reading is free. Adding or changing a reminder (the owner's own list, easy to undo) runs without asking;
 * deleting asks as irreversible. Every write takes a LIST of 1 to 20 reminders and the phone does the whole list in one `device.call`
 * (one EventKit commit), so a request like "add these five" or "delete those three" is one step, one card in the chat and, for a
 * delete, one approval for all of them. The phone answers per item (done, or failed with the reason); `presentBatch` turns that into the text
 * the agent and the chat card read.
 */
import { z } from 'zod';
import type { ToolResult } from '../../../../contracts/index.js';
import { cap, type PhoneToolDef } from './def.js';

/** Most reminders one call may carry. */
export const REMINDER_BATCH_MAX = 20;

/** A location alarm: the phone looks the name up itself when there are no coordinates (both or neither). */
const place = z.object({
  name: z.string().trim().min(2).max(200),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  radiusMeters: z.number().min(50).max(5000).optional(),
  when: z.enum(['arriving', 'leaving']),
}).strict().refine((value) => (value.latitude === undefined) === (value.longitude === undefined), { message: 'give both latitude and longitude, or neither' }).optional();

const batch = <T extends z.ZodTypeAny>(item: T) => z.object({ reminders: z.array(item).min(1).max(REMINDER_BATCH_MAX) }).strict();

const createItem = z.object({ title: z.string().min(1).max(300), list: z.string().optional(), due: z.string().min(1).optional(), notes: z.string().max(4000).optional(), place }).strict();
const updateItem = z.object({ id: z.string().min(1), title: z.string().min(1).max(300).optional(), due: z.string().min(1).optional(), notes: z.string().max(4000).optional(), completed: z.boolean().optional() }).strict();
/** `title` and `due` are what the owner reads on the approval card; the phone deletes by `id` only. */
const deleteItem = z.object({ id: z.string().min(1), title: z.string().min(1).max(300), due: z.string().min(1).optional() }).strict();

const batchProperty = (item: Record<string, unknown>) => ({ reminders: { type: 'array', description: '', minItems: 1, maxItems: REMINDER_BATCH_MAX, items: item } });

const PLACE_PROPERTY = {
  type: 'object', description: '',
  properties: {
    name: { type: 'string', description: '' },
    latitude: { type: 'number' }, longitude: { type: 'number' },
    radiusMeters: { type: 'number', description: '' },
    when: { type: 'string', enum: ['arriving', 'leaving'], description: '' },
  },
  required: ['name', 'when'], additionalProperties: false,
};

const answer = z.object({
  results: z.array(z.union([
    z.object({ ok: z.literal(true), reminder: z.object({ id: z.string(), title: z.string().optional(), due: z.string().optional() }).passthrough() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ])),
});

/** The reminders of a delete call as the owner reads them on the approval card, one line each: "Watch Crime Scene · 2026-08-08 22:00". */
export function reminderLabels(args: unknown): string[] {
  const items: unknown = typeof args === 'object' && args !== null ? Reflect.get(args, 'reminders') : undefined;
  if (!Array.isArray(items)) return [];
  return items.slice(0, REMINDER_BATCH_MAX).flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const title: unknown = Reflect.get(item, 'title');
    const due: unknown = Reflect.get(item, 'due');
    const name = typeof title === 'string' && title !== '' ? title : 'A reminder';
    return [(typeof due === 'string' && due !== '' ? `${name} · ${due.slice(0, 16).replace('T', ' ')}` : name).slice(0, 160)];
  });
}

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });

/**
 * The phone's per-item answer as text: the first line says how many were done ("Added 2 of 3 reminders; 1 failed."; the chat row
 * shows it as the card title), then one line per item in the order sent, with the id the agent needs for a later change.
 * A call where nothing was done is an error result.
 */
function presentBatch(past: string) {
  return async (data: unknown, args: Record<string, unknown>): Promise<ToolResult> => {
    const asked = Array.isArray(args['reminders']) ? args['reminders'] as Array<Record<string, unknown>> : [];
    const parsed = answer.safeParse(data);
    if (!parsed.success || parsed.data.results.length !== asked.length) {
      return text(`The iPhone answered, but not item by item, so it is unclear what was done. Read the reminders (phone_reminders_list) to check before trying again. Answer: ${JSON.stringify(data ?? null).slice(0, 500)}`, true);
    }
    const { results } = parsed.data;
    const done = results.filter((result) => result.ok).length;
    const failed = results.length - done;
    const noun = asked.length === 1 ? 'reminder' : 'reminders';
    const head = failed === 0 ? `${past} ${String(done)} ${noun}.` : done === 0 ? `${past} none of the ${String(asked.length)} ${noun}; ${failed === 1 ? 'it' : 'all'} failed.` : `${past} ${String(done)} of ${String(asked.length)} reminders; ${String(failed)} failed.`;
    const lines = results.map((result, index) => {
      const name = String(asked[index]?.['title'] ?? asked[index]?.['id'] ?? 'reminder');
      if (!result.ok) return `- Failed "${name}": ${result.error}`;
      const { id, title, due } = result.reminder;
      return `- "${title ?? name}" (id ${id}${due === undefined ? '' : `, due ${due}`})`;
    });
    return text([head, ...lines].join('\n'), done === 0);
  };
}

export const REMINDERS_DEFS: readonly PhoneToolDef[] = [
  {
    name: 'phone_reminders_list', call: 'reminders.list',
    description: '',
    properties: { list: { type: 'string', description: '' }, includeCompleted: { type: 'boolean' }, limit: { type: 'number', description: '' } },
    schema: z.object({ list: z.string().optional(), includeCompleted: z.boolean().optional(), limit: cap(100) }).strict(),
  },
  {
    name: 'phone_reminders_create', call: 'reminders.create', changes: true, present: presentBatch('Added'),
    description: '',
    properties: batchProperty({
      type: 'object',
      properties: { title: { type: 'string' }, list: { type: 'string', description: '' }, due: { type: 'string', description: '' }, notes: { type: 'string' }, place: PLACE_PROPERTY },
      required: ['title'], additionalProperties: false,
    }),
    required: ['reminders'], schema: batch(createItem),
  },
  {
    name: 'phone_reminders_update', call: 'reminders.update', changes: true, present: presentBatch('Changed'),
    description: '',
    properties: batchProperty({
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' }, due: { type: 'string', description: '' }, notes: { type: 'string' }, completed: { type: 'boolean' } },
      required: ['id'], additionalProperties: false,
    }),
    required: ['reminders'], schema: batch(updateItem),
  },
  {
    name: 'phone_reminders_delete', call: 'reminders.delete', decision: 'irreversible', present: presentBatch('Deleted'),
    description: '',
    properties: batchProperty({
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string', description: '' }, due: { type: 'string', description: '' } },
      required: ['id', 'title'], additionalProperties: false,
    }),
    required: ['reminders'], schema: batch(deleteItem),
  },
];
