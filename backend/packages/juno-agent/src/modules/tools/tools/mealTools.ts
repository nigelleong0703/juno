// meal_log / meal_update / meal_delete / meal_summary: the agent's side of the user's food diary (`meals`).
// Owner and agent come from the ToolContext, never from arguments. The model supplies items with its own
// estimates; the entry's totals are always summed from the items here, so they cannot disagree.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import { mealConfidenceSchema, mealItemSchema, mealSourceSchema, mealTypeSchema, type Meal } from '@agent-desktop/public-contracts';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { docOwner } from '../../../execution/execution-owner.js';
import { readOwnerTimeZone } from '../../../execution/brain/context.js';
import { localDate } from '../../home/paths.js';
import { parseEatenAt, sumNutrients, summarizeMeals } from '../../meals/index.js';
import { listAll } from '../../memory/util.js';
import { nowIso } from '../util.js';

const MAX_RANGE_DAYS = 92;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const itemsSchema = z.array(mealItemSchema).min(1).max(30);
const fields = {
  eatenAt: z.string().min(1).optional(),
  mealType: mealTypeSchema.optional(),
  description: z.string().trim().min(1).max(300).optional(),
  items: itemsSchema.optional(),
  photoFileId: z.string().min(1).optional(),
  confidence: mealConfidenceSchema.optional(),
  source: mealSourceSchema.optional(),
};
const logSchema = z.object({ ...fields, mealType: mealTypeSchema, description: z.string().trim().min(1).max(300), items: itemsSchema, source: mealSourceSchema }).strict();
const updateSchema = z.object({ id: z.string().min(1), ...fields }).strict();
const idArgsSchema = z.object({ id: z.string().min(1) }).strict();
const summarySchema = z.object({ from: dateSchema, to: dateSchema }).strict();

const itemSchemaJson = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    portion: { type: 'string', description: '' },
    kcal: { type: 'number' },
    proteinG: { type: 'number' },
    carbsG: { type: 'number' },
    fatG: { type: 'number' },
    fiberG: { type: 'number' },
    sugarG: { type: 'number' },
    sodiumMg: { type: 'number' },
  },
  required: ['name', 'portion', 'kcal', 'proteinG', 'carbsG', 'fatG'],
};

function result(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) };
}

const invalid = invalidArguments;

const noCaller = (): ToolResult => result('no owner context, so the food diary is unavailable.', true);

/** A one-line receipt: what was stored and the id to correct it by. */
function receipt(verb: string, meal: Meal): string {
  return `${verb} ${meal.mealType} "${meal.description}" (${String(Math.round(meal.totals.kcal))} kcal, P ${String(Math.round(meal.totals.proteinG))}g C ${String(Math.round(meal.totals.carbsG))}g F ${String(Math.round(meal.totals.fatG))}g, ${meal.confidence}) at ${meal.eatenAt}, id ${meal.id}.`;
}

/** The photo must be one of this owner's own library files. */
async function photoExists(ctx: ToolContext, id: string): Promise<boolean> {
  const scoped = ctx.store.forOwner?.(ctx.ownerId);
  return scoped !== undefined && (await scoped.get('library', id)) !== null;
}

async function ownMeal(ctx: ToolContext, id: string): Promise<Meal | undefined> {
  const row = await ctx.store.get('meals', id);
  return row !== null && docOwner(row) === ctx.ownerId ? row : undefined;
}

export function createMealLogTool(): Tool {
  return {
    name: 'meal_log',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        mealType: { enum: ['breakfast', 'lunch', 'dinner', 'snack', 'drink'] },
        description: { type: 'string', description: '' },
        items: { type: 'array', description: '', items: itemSchemaJson },
        source: { enum: ['photo', 'text', 'label'], description: '' },
        confidence: { enum: ['estimate', 'label', 'user'], description: '' },
        eatenAt: { type: 'string', description: '' },
        photoFileId: { type: 'string', description: '' },
      },
      required: ['mealType', 'description', 'items', 'source'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = logSchema.safeParse(args);
      if (!parsed.success) return invalid('meal_log', args, parsed.error);
      if (ctx.ownerId.length === 0) return noCaller();
      const input = parsed.data;
      const zone = await readOwnerTimeZone(ctx.store, ctx.ownerId);
      const eatenAt = input.eatenAt === undefined ? nowIso() : parseEatenAt(input.eatenAt, zone);
      if (eatenAt === undefined) return result('eatenAt must be an ISO time, or a local time like 2026-10-19T12:30.', true);
      if (input.photoFileId !== undefined && !(await photoExists(ctx, input.photoFileId))) return result('photoFileId is not one of the user\'s files.', true);
      return ctx.step('meal_log', async (): Promise<ToolResult> => {
        const now = nowIso();
        const meal: Meal & { ownerId: string } = {
          id: 'meal-' + String(Date.now()) + '-' + randomUUID().slice(0, 8),
          ownerId: ctx.ownerId,
          ...(ctx.agentId.length > 0 ? { agentId: ctx.agentId } : {}),
          eatenAt,
          mealType: input.mealType,
          description: input.description,
          items: input.items,
          totals: sumNutrients(input.items),
          ...(input.photoFileId === undefined ? {} : { photoFileId: input.photoFileId }),
          confidence: input.confidence ?? (input.source === 'label' ? 'label' : 'estimate'),
          source: input.source,
          createdAt: now,
          updatedAt: now,
        };
        return result(receipt('Logged', await ctx.store.put('meals', meal)));
      });
    },
  };
}

export function createMealUpdateTool(): Tool {
  return {
    name: 'meal_update',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        mealType: { enum: ['breakfast', 'lunch', 'dinner', 'snack', 'drink'] },
        description: { type: 'string' },
        items: { type: 'array', description: '', items: itemSchemaJson },
        source: { enum: ['photo', 'text', 'label'] },
        confidence: { enum: ['estimate', 'label', 'user'] },
        eatenAt: { type: 'string', description: '' },
        photoFileId: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = updateSchema.safeParse(args);
      if (!parsed.success) return invalid('meal_update', args, parsed.error);
      if (ctx.ownerId.length === 0) return noCaller();
      const { id, eatenAt: eatenAtRaw, ...rest } = parsed.data;
      let eatenAt: string | undefined;
      if (eatenAtRaw !== undefined) {
        eatenAt = parseEatenAt(eatenAtRaw, await readOwnerTimeZone(ctx.store, ctx.ownerId));
        if (eatenAt === undefined) return result('eatenAt must be an ISO time, or a local time like 2026-10-19T12:30.', true);
      }
      if (rest.photoFileId !== undefined && !(await photoExists(ctx, rest.photoFileId))) return result('photoFileId is not one of the user\'s files.', true);
      return ctx.step('meal_update', async (): Promise<ToolResult> => {
        const existing = await ownMeal(ctx, id);
        if (existing === undefined) return result('no meal with id ' + id + '.', true);
        const patch: Partial<Meal> = { ...rest, ...(eatenAt === undefined ? {} : { eatenAt }), updatedAt: nowIso() };
        if (rest.items !== undefined) patch.totals = sumNutrients(rest.items);
        return result(receipt('Updated', await ctx.store.patch('meals', id, patch)));
      });
    },
  };
}

export function createMealDeleteTool(): Tool {
  return {
    name: 'meal_delete',
    description: '',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = idArgsSchema.safeParse(args);
      if (!parsed.success) return invalid('meal_delete', args, parsed.error);
      if (ctx.ownerId.length === 0) return noCaller();
      const { id } = parsed.data;
      return ctx.step('meal_delete', async (): Promise<ToolResult> => {
        const existing = await ownMeal(ctx, id);
        if (existing === undefined) return result('no meal with id ' + id + '.', true);
        await ctx.store.delete('meals', id);
        return result(`Deleted ${existing.mealType} "${existing.description}".`);
      });
    },
  };
}

export function createMealSummaryTool(): Tool {
  return {
    name: 'meal_summary',
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
      const parsed = summarySchema.safeParse(args);
      if (!parsed.success) return invalid('meal_summary', args, parsed.error);
      if (ctx.ownerId.length === 0) return noCaller();
      const { from, to } = parsed.data;
      if (to < from) return result('"to" is before "from".', true);
      if (Date.parse(to) - Date.parse(from) > (MAX_RANGE_DAYS - 1) * 86_400_000) return result(`ask for at most ${String(MAX_RANGE_DAYS)} days at a time.`, true);
      const zone = await readOwnerTimeZone(ctx.store, ctx.ownerId);
      const rows = (await listAll(ctx.store, 'meals')).filter((row) => docOwner(row) === ctx.ownerId);
      const today = localDate(new Date(), zone);
      return result(`Food diary ${from} to ${to} (today is ${today}${zone === undefined ? ', times in UTC' : ', ' + zone}):\n` + summarizeMeals(rows, from, to, zone));
    },
  };
}
