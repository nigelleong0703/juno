/** Calendar on the iPhone (EventKit). Creating or changing an event asks the owner; deleting, or changing a whole series, asks as irreversible. Reminders are in `reminders.ts`. */
import { z } from 'zod';
import { cap, type PhoneToolDef } from './def.js';

const span = z.enum(['this', 'future']).optional();
const SPAN = { enum: ['this', 'future'], description: '' };
const wholeSeries = (args: Record<string, unknown>) => (args['span'] === 'future' ? 'irreversible' as const : undefined);

export const CALENDAR_DEFS: readonly PhoneToolDef[] = [
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
    name: 'phone_calendar_create_event', call: 'calendar.create_event', decision: 'committing',
    description: '',
    properties: { title: { type: 'string' }, start: { type: 'string', description: '' }, end: { type: 'string', description: '' }, allDay: { type: 'boolean' }, calendar: { type: 'string', description: '' }, location: { type: 'string' }, notes: { type: 'string' } },
    required: ['title', 'start', 'end'],
    schema: z.object({ title: z.string().min(1).max(300), start: z.string().min(1), end: z.string().min(1), allDay: z.boolean().optional(), calendar: z.string().optional(), location: z.string().max(300).optional(), notes: z.string().max(4000).optional() }).strict(),
  },
  {
    name: 'phone_calendar_update_event', call: 'calendar.update_event', decision: 'committing', stricter: wholeSeries,
    description: '',
    properties: { id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string', description: '' }, end: { type: 'string', description: '' }, location: { type: 'string' }, notes: { type: 'string' }, span: SPAN },
    required: ['id'],
    schema: z.object({ id: z.string().min(1), title: z.string().min(1).max(300).optional(), start: z.string().min(1).optional(), end: z.string().min(1).optional(), location: z.string().max(300).optional(), notes: z.string().max(4000).optional(), span }).strict(),
  },
  {
    name: 'phone_calendar_delete_event', call: 'calendar.delete_event', decision: 'irreversible',
    description: '',
    properties: { id: { type: 'string' }, span: SPAN }, required: ['id'], schema: z.object({ id: z.string().min(1), span }).strict(),
  },
];
