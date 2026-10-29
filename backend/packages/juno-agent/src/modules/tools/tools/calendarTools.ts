// schedule_add / schedule_list / schedule_update / schedule_cancel: the agent's OWN schedule, separate from the owner's
// Calendar app. One-off items only (a follow-up it promised, a meeting it joins itself, a task for later); recurring work is a routine.
// Owner and agent come from the ToolContext. Each change re-arms the item's CalendarTimer so the wake matches what is stored.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentCalendarKindSchema, agentCalendarMeetingSchema, agentCalendarWithWhomSchema, type AgentCalendarItem } from '@agent-desktop/public-contracts';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { readOwnerTimeZone } from '../../../execution/brain/context.js';
import { agentCalendarItems, formatCalendarTime } from '../../calendar/index.js';
import { parseEatenAt } from '../../meals/index.js';
import { nowIso } from '../util.js';
import { invalidArguments } from '../toolArguments.js';

const MAX_OPEN = 100;
const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: isError ? 'Error: ' + value : value }], ...(isError ? { isError } : {}) });

const addSchema = z.object({
  kind: agentCalendarKindSchema,
  title: z.string().trim().min(1).max(200),
  at: z.string().min(1),
  endAt: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  instructions: z.string().trim().min(1).max(4000),
  withWhom: agentCalendarWithWhomSchema.optional(),
  meeting: agentCalendarMeetingSchema.optional(),
}).strict();
const listSchema = z.object({ from: z.string().min(1).optional(), to: z.string().min(1).optional() }).strict();
const updateSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  at: z.string().min(1).optional(),
  // null clears the end time; leaving it out keeps it.
  endAt: z.string().min(1).nullable().optional(),
  timezone: z.string().min(1).optional(),
  instructions: z.string().trim().min(1).max(4000).optional(),
  result: z.string().trim().max(1000).optional(),
}).strict();
const cancelSchema = z.object({ id: z.string().min(1) }).strict();

const line = (item: AgentCalendarItem): string => `${item.id}  ${formatCalendarTime(item.at, item.timezone)}  ${item.kind} [${item.status}] "${item.title}"${item.result === undefined ? '' : ` — ${item.result}`}`;

/** This agent's own row, or undefined. */
async function ownItem(ctx: ToolContext, id: string): Promise<AgentCalendarItem | undefined> {
  const row = await ctx.store.get('agentCalendar', id);
  return row !== null && row.agentId === ctx.agentId && row.ownerId === ctx.ownerId ? row : undefined;
}

async function zoneOf(ctx: ToolContext, given: string | undefined): Promise<string> {
  return given ?? (await readOwnerTimeZone(ctx.store, ctx.ownerId)) ?? 'UTC';
}

export function createCalendarTools(): Tool[] {
  const add: Tool = {
    name: 'schedule_add',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        kind: { enum: ['follow_up', 'meeting', 'task'], description: '' },
        title: { type: 'string', maxLength: 200, description: '' },
        at: { type: 'string', description: '' },
        endAt: { type: 'string', description: '' },
        timezone: { type: 'string', description: '' },
        instructions: { type: 'string', maxLength: 4000, description: '' },
        withWhom: { type: 'object', description: '', properties: { name: { type: 'string' }, channel: { type: 'object', properties: { kind: { type: 'string' }, target: { type: 'string' } }, required: ['kind', 'target'] } }, required: ['name'] },
        meeting: { type: 'object', description: '', properties: { platform: { enum: ['discord', 'other'] }, channelId: { type: 'string', description: '' }, url: { type: 'string', description: '' } }, required: ['platform'] },
      },
      required: ['kind', 'title', 'at', 'instructions'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = addSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(add.name, args, parsed.error);
      const input = parsed.data;
      const timezone = await zoneOf(ctx, input.timezone);
      const at = parseEatenAt(input.at, timezone);
      const endAt = input.endAt === undefined ? undefined : parseEatenAt(input.endAt, timezone);
      if (at === undefined || (input.endAt !== undefined && endAt === undefined)) return text('at and endAt must be an ISO time, or a local time like 2026-10-22T15:00.', true);
      if (Date.parse(at) <= Date.now()) return text('That time has already passed; pick a time in the future.', true);
      return ctx.step('schedule_add', async (): Promise<ToolResult> => {
        if ((await agentCalendarItems(ctx.store, ctx.agentId, 'scheduled')).length >= MAX_OPEN) return text(`Your schedule already has ${String(MAX_OPEN)} scheduled items; cancel some first.`, true);
        const now = nowIso();
        const item: AgentCalendarItem = {
          id: 'cal-' + randomUUID(), agentId: ctx.agentId, ownerId: ctx.ownerId, kind: input.kind, title: input.title, at,
          ...(endAt === undefined ? {} : { endAt }), timezone, instructions: input.instructions,
          ...(input.withWhom === undefined ? {} : { withWhom: input.withWhom }), ...(input.meeting === undefined ? {} : { meeting: input.meeting }),
          ...(ctx.conversationId.length > 0 ? { conversationId: ctx.conversationId } : {}),
          status: 'scheduled', createdAt: now, updatedAt: now,
        };
        const put = await ctx.store.put('agentCalendar', item);
        await ctx.enqueuer.scheduleCalendarItem?.(put.id);
        return text(`Added to your schedule:${line(put)}`);
      });
    },
  };

  const list: Tool = {
    name: 'schedule_list',
    description: '',
    parameters: { type: 'object', properties: { from: { type: 'string', description: '' }, to: { type: 'string', description: '' } }, additionalProperties: false },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = listSchema.safeParse(args ?? {});
      if (!parsed.success) return invalidArguments(list.name, args, parsed.error);
      const zone = await zoneOf(ctx, undefined);
      const from = parsed.data.from === undefined ? Date.now() : Date.parse(parseEatenAt(parsed.data.from, zone) ?? '');
      const to = parsed.data.to === undefined ? Infinity : Date.parse(parseEatenAt(parsed.data.to, zone) ?? '');
      if (Number.isNaN(from) || Number.isNaN(to)) return text('from and to must be ISO times.', true);
      const items = (await agentCalendarItems(ctx.store, ctx.agentId)).filter((i) => i.ownerId === ctx.ownerId && Date.parse(i.at) >= from && Date.parse(i.at) < to).slice(0, 50);
      return text(items.length === 0 ? 'Nothing on your schedule in that range.' : items.map(line).join('\n'));
    },
  };

  const update: Tool = {
    name: 'schedule_update',
    description: '',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '' }, title: { type: 'string', maxLength: 200 }, at: { type: 'string', description: '' }, endAt: { type: ['string', 'null'], description: '' }, timezone: { type: 'string', description: '' }, instructions: { type: 'string', maxLength: 4000 }, result: { type: 'string', maxLength: 1000, description: '' } },
      required: ['id'],
      additionalProperties: false,
    },
    clearable: ['endAt'],
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = updateSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(update.name, args, parsed.error);
      const { id, at, endAt, timezone, ...rest } = parsed.data;
      const item = await ownItem(ctx, id);
      if (item === undefined) return text(`No schedule item ${id} on your schedule.`, true);
      const zone = timezone ?? item.timezone;
      const movedAt = at === undefined ? undefined : parseEatenAt(at, zone);
      const movedEnd = endAt === undefined || endAt === null ? undefined : parseEatenAt(endAt, zone);
      if ((at !== undefined && movedAt === undefined) || (typeof endAt === 'string' && movedEnd === undefined)) return text('at and endAt must be an ISO time, or a local time like 2026-10-22T15:00.', true);
      if (movedAt !== undefined && item.status !== 'scheduled') return text(`The item is ${item.status}; add a new one instead of moving it.`, true);
      if (movedAt !== undefined && Date.parse(movedAt) <= Date.now()) return text('That time has already passed; pick a time in the future.', true);
      return ctx.step('schedule_update',async (): Promise<ToolResult> => {
        const changes = {
          ...rest, ...(timezone === undefined ? {} : { timezone }), ...(movedAt === undefined ? {} : { at: movedAt }), ...(movedEnd === undefined ? {} : { endAt: movedEnd }), updatedAt: nowIso(),
        };
        // A patch only adds or changes fields, so removing the end time rewrites the row without it.
        const { endAt: _removed, ...kept } = item;
        const patched = endAt === null ? await ctx.store.put('agentCalendar', { ...kept, ...changes }) : await ctx.store.patch('agentCalendar', id, changes);
        if (movedAt !== undefined) await ctx.enqueuer.scheduleCalendarItem?.(id);
        return text(`Updated: ${line(patched)}`);
      });
    },
  };

  const cancel: Tool = {
    name: 'schedule_cancel',
    description: '',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = cancelSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(cancel.name, args, parsed.error);
      const item = await ownItem(ctx, parsed.data.id);
      if (item === undefined) return text(`No schedule item ${parsed.data.id} on your schedule.`, true);
      if (item.status !== 'scheduled') return text(`That item is already ${item.status}.`, true);
      return ctx.step('schedule_cancel',async (): Promise<ToolResult> => {
        const patched = await ctx.store.patch('agentCalendar', item.id, { status: 'cancelled', updatedAt: nowIso() });
        await ctx.enqueuer.scheduleCalendarItem?.(item.id);
        return text(`Cancelled: ${line(patched)}`);
      });
    },
  };

  const get: Tool = {
    name: 'schedule_get',
    description: '',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = cancelSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(get.name, args, parsed.error);
      const item = await ownItem(ctx, parsed.data.id);
      if (item === undefined) return text(`No schedule item ${parsed.data.id} on your schedule.`, true);
      const lines = [line(item)];
      if (item.endAt !== undefined) lines.push(`Ends: ${formatCalendarTime(item.endAt, item.timezone)}`);
      lines.push(`Instructions: ${item.instructions}`);
      if (item.withWhom !== undefined) lines.push(`With: ${item.withWhom.name}${item.withWhom.channel === undefined ? '' : ` (${item.withWhom.channel.kind}: ${item.withWhom.channel.target})`}`);
      if (item.meeting !== undefined) lines.push(`Meeting: ${item.meeting.platform}${item.meeting.channelId === undefined ? '' : ` channel ${item.meeting.channelId}`}${item.meeting.url === undefined ? '' : ` ${item.meeting.url}`}`);
      return text(lines.join('\n'));
    },
  };

  return [add, list, get, update, cancel];
}
