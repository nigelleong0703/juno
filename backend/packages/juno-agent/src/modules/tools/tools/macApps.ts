/**
 * Mail, Calendar, Reminders and Notes on the owner's Mac (My Mac), for any account added in macOS Internet Accounts. The desktop
 * app on the Mac runs them (BACKEND "Mac 连接器"); here each tool only names the call. Reads are free; every write asks the
 * owner each time (tool-policy builtin.mac-apps), sending mail included.
 */
import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient, type ComputerClientProvider } from '../computer/client.js';
import { ComputerError } from '../computer/contract.js';
import { actionResult, computerFailure } from '../computer/shared.js';

/** The tools that change something: policy asks first for each. */
export const MAC_APP_WRITE_TOOLS: ReadonlySet<string> = new Set(['mac_mail_create_draft', 'mac_mail_send', 'mac_calendar_create_event', 'mac_reminders_create', 'mac_reminders_complete', 'mac_notes_create', 'mac_notes_append']);
/** Every tool of this unit. */
export const MAC_APP_TOOLS: ReadonlySet<string> = new Set(['mac_mail_search', 'mac_mail_read', 'mac_calendar_list_events', 'mac_reminders_list', 'mac_notes_search', 'mac_notes_read', ...MAC_APP_WRITE_TOOLS]);

/** Whether this agent can use Mail, Calendar and Reminders right now: the owner allowed it, and the paired Mac's link is up. */
export async function macUsable(store: Store, computer: ComputerClientProvider | undefined, agentId: string, signal: AbortSignal = AbortSignal.timeout(5_000)): Promise<boolean> {
  if ((await store.get('agents', agentId))?.macAccess !== true) return false;
  const status = await computer?.()?.macStatus?.(agentId, signal).catch(() => undefined);
  return status?.paired === true && status.online;
}

const strings = { type: 'array', items: { type: 'string' } };
const cap = (max: number) => z.number().int().positive().max(max).optional();
const compose = z.object({ to: z.array(z.string().min(1)).min(1), subject: z.string().min(1), body: z.string(), cc: z.array(z.string().min(1)).optional() }).strict();

interface Def {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  schema: z.ZodType<Record<string, unknown>>;
}

const DEFS: readonly Def[] = [
  {
    name: 'mac_mail_search', description: '',
    properties: { query: { type: 'string' }, mailbox: { type: 'string', description: '' }, limit: { type: 'number', description: '' } },
    required: ['query'], schema: z.object({ query: z.string().min(1), mailbox: z.string().optional(), limit: cap(25) }).strict(),
  },
  {
    name: 'mac_mail_read', description: '',
    properties: { id: { type: 'string' } }, required: ['id'], schema: z.object({ id: z.string().min(1) }).strict(),
  },
  {
    name: 'mac_mail_create_draft', description: '',
    properties: { to: strings, subject: { type: 'string' }, body: { type: 'string' }, cc: strings }, required: ['to', 'subject', 'body'], schema: compose,
  },
  {
    name: 'mac_mail_send', description: '',
    properties: { to: strings, subject: { type: 'string' }, body: { type: 'string' }, cc: strings }, required: ['to', 'subject', 'body'], schema: compose,
  },
  {
    name: 'mac_calendar_list_events', description: '',
    properties: { from: { type: 'string', description: '' }, to: { type: 'string', description: '' }, calendar: { type: 'string' }, limit: { type: 'number', description: '' } },
    required: ['from', 'to'], schema: z.object({ from: z.string().min(1), to: z.string().min(1), calendar: z.string().optional(), limit: cap(50) }).strict(),
  },
  {
    name: 'mac_calendar_create_event', description: '',
    properties: { title: { type: 'string' }, start: { type: 'string', description: '' }, end: { type: 'string', description: '' }, calendar: { type: 'string' }, location: { type: 'string' }, notes: { type: 'string' } },
    required: ['title', 'start', 'end'], schema: z.object({ title: z.string().min(1), start: z.string().min(1), end: z.string().min(1), calendar: z.string().optional(), location: z.string().optional(), notes: z.string().optional() }).strict(),
  },
  {
    name: 'mac_reminders_list', description: '',
    properties: { list: { type: 'string' }, includeCompleted: { type: 'boolean' }, limit: { type: 'number', description: '' } },
    schema: z.object({ list: z.string().optional(), includeCompleted: z.boolean().optional(), limit: cap(50) }).strict(),
  },
  {
    name: 'mac_reminders_create', description: '',
    properties: { title: { type: 'string' }, list: { type: 'string' }, due: { type: 'string', description: '' }, notes: { type: 'string' } },
    required: ['title'], schema: z.object({ title: z.string().min(1), list: z.string().optional(), due: z.string().optional(), notes: z.string().optional() }).strict(),
  },
  {
    name: 'mac_reminders_complete', description: '',
    properties: { id: { type: 'string' } }, required: ['id'], schema: z.object({ id: z.string().min(1) }).strict(),
  },
  {
    name: 'mac_notes_search', description: '',
    properties: { query: { type: 'string' }, limit: { type: 'number', description: '' } },
    required: ['query'], schema: z.object({ query: z.string().min(1), limit: cap(20) }).strict(),
  },
  {
    name: 'mac_notes_read', description: '',
    properties: { id: { type: 'string' } }, required: ['id'], schema: z.object({ id: z.string().min(1) }).strict(),
  },
  {
    name: 'mac_notes_create', description: '',
    properties: { title: { type: 'string' }, body: { type: 'string' }, folder: { type: 'string' } },
    required: ['title', 'body'], schema: z.object({ title: z.string().min(1), body: z.string(), folder: z.string().optional() }).strict(),
  },
  {
    name: 'mac_notes_append', description: '',
    properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'], schema: z.object({ id: z.string().min(1), text: z.string().min(1) }).strict(),
  },
];

export function createMacAppsTools(opts: { computer?: ComputerClientProvider }): Tool[] {
  return DEFS.map((def): Tool => {
    const writes = MAC_APP_WRITE_TOOLS.has(def.name);
    return {
      name: def.name,
      description: def.description,
      parameters: { type: 'object', properties: def.properties, ...(def.required === undefined ? {} : { required: def.required }), additionalProperties: false },
      replay: writes ? 'never' : 'safe',
      sideEffect: writes,
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const parsed = def.schema.parse(args);
        try {
          const client = requireComputerClient(opts.computer);
          if (client.macApps === undefined) throw new ComputerError('unavailable', "Mail, Calendar, Reminders and Notes are not available on this agent's Mac connection.");
          return actionResult(await client.macApps(ctx.agentId, { tool: def.name.slice('mac_'.length), args: parsed }, ctx.signal));
        } catch (error) {
          return computerFailure(error, ctx.signal);
        }
      },
    };
  });
}
