import { z } from 'zod';
import { idSchema } from './common.js';

/**
 * Juno UI blocks (BACKEND 8.7.1): one small component standard shared by the agent (emits it), the server
 * (validates it, renders `uiDocToText`) and the clients (render it natively). Layout comes from the model;
 * consequential data (a purchase approval) is built by the server from structured args.
 */

const httpsUrl = z.url().max(2000).refine((value) => value.startsWith('https://'), 'must be an https URL');
const oneLine = (max: number) => z.string().min(1).max(max).refine((value) => !/[\r\n]/.test(value), 'must be a single line');

/** A markdown header or table row inside a prose value: structure belongs in a block, not in text. */
const MARKDOWN_STRUCTURE = /^\s*(#{1,6}\s|\|.*\||[-: |]{3,}$)/m;
const prose = (max: number) =>
  z.string().min(1).max(max).refine((value) => !MARKDOWN_STRUCTURE.test(value), 'no markdown headers or tables here: use a facts, items or table block');

export const MAX_UI_DOC_BYTES = 8 * 1024;
export const MAX_UI_BLOCKS = 12;

export const uiTextBlockSchema = z.object({ type: z.literal('text'), text: prose(400) });

export const uiFactsBlockSchema = z.object({
  type: z.literal('facts'),
  rows: z.array(z.object({ label: oneLine(24), value: oneLine(120), emphasis: z.boolean().optional() })).min(1).max(8),
});

export const uiItemsBlockSchema = z.object({
  type: z.literal('items'),
  rows: z
    .array(
      z.object({
        name: oneLine(120),
        detail: oneLine(120).optional(),
        quantity: z.number().int().min(1).optional(),
        price: oneLine(40).optional(),
        imageUrl: httpsUrl.optional(),
      }),
    )
    .min(1)
    .max(20),
  total: z.object({ label: oneLine(24), value: oneLine(40) }).optional(),
});

export const uiTableBlockSchema = z
  .object({
    type: z.literal('table'),
    columns: z.array(oneLine(24)).min(2).max(5),
    rows: z.array(z.array(z.string().max(60))).min(1).max(20),
  })
  .superRefine((table, ctx) => {
    table.rows.forEach((row, index) => {
      if (row.length !== table.columns.length) {
        ctx.addIssue({ code: 'custom', path: ['rows', index], message: `row has ${row.length} cells but there are ${table.columns.length} columns` });
      }
    });
  });

export const uiNoticeBlockSchema = z.object({
  type: z.literal('notice'),
  tone: z.enum(['info', 'warning', 'success']),
  text: prose(200),
});

export const uiLinkBlockSchema = z.object({
  type: z.literal('link'),
  url: httpsUrl,
  title: oneLine(80),
  subtitle: oneLine(120).optional(),
});

export const uiImageBlockSchema = z.object({
  type: z.literal('image'),
  /** An image in the owner's library: `GET /v1/library/:id/download`. */
  libraryId: idSchema,
  caption: oneLine(120).optional(),
});

export const uiChoiceOptionSchema = z.object({
  id: oneLine(40),
  label: oneLine(40),
  style: z.enum(['primary', 'default', 'destructive']).optional(),
  description: oneLine(120).optional(),
});

/** Interactive: pick one option (or several with `multiple`). */
export const uiChoicesBlockSchema = z.object({
  type: z.literal('choices'),
  id: oneLine(40),
  options: z.array(uiChoiceOptionSchema).min(2).max(6),
  multiple: z.boolean().optional(),
});

export const uiFieldSchema = z
  .object({
    id: oneLine(40),
    label: oneLine(60),
    kind: z.enum(['text', 'number', 'date', 'select']),
    /** Required for `select`. */
    options: z.array(oneLine(60)).min(1).max(20).optional(),
    required: z.boolean().optional(),
    placeholder: oneLine(60).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.kind === 'select' && field.options === undefined) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'a select field needs options' });
    }
  });

/** Interactive: non-secret input (a password, card or code keeps request_secure_input). */
export const uiFieldsBlockSchema = z.object({
  type: z.literal('fields'),
  id: oneLine(40),
  fields: z.array(uiFieldSchema).min(1).max(8),
});

/** Quick replies: buttons that send their label as the user's next message. Display-compatible (usable in a plain message). */
export const uiRepliesBlockSchema = z.object({
  type: z.literal('replies'),
  options: z.array(oneLine(40)).min(1).max(3),
});

/** The blocks a group may hold: display blocks only, so no interaction and no nesting. */
const uiLeafBlockSchema = z.discriminatedUnion('type', [
  uiTextBlockSchema,
  uiFactsBlockSchema,
  uiItemsBlockSchema,
  uiTableBlockSchema,
  uiNoticeBlockSchema,
  uiLinkBlockSchema,
  uiImageBlockSchema,
]);

/** Related blocks rendered as one titled section, e.g. one group per option when comparing configurations. */
export const uiGroupBlockSchema = z.object({
  type: z.literal('group'),
  title: oneLine(60).optional(),
  blocks: z.array(uiLeafBlockSchema).min(1).max(8),
});

export const uiBlockSchema = z.discriminatedUnion('type', [
  uiTextBlockSchema,
  uiFactsBlockSchema,
  uiItemsBlockSchema,
  uiTableBlockSchema,
  uiNoticeBlockSchema,
  uiLinkBlockSchema,
  uiImageBlockSchema,
  uiGroupBlockSchema,
  uiRepliesBlockSchema,
  uiChoicesBlockSchema,
  uiFieldsBlockSchema,
]);
export type UiBlock = z.infer<typeof uiBlockSchema>;
type UiLeafBlock = z.infer<typeof uiLeafBlockSchema>;
export type UiChoicesBlock = z.infer<typeof uiChoicesBlockSchema>;
export type UiFieldsBlock = z.infer<typeof uiFieldsBlockSchema>;
export type UiField = z.infer<typeof uiFieldSchema>;

export function isInteractiveBlock(block: UiBlock): block is UiChoicesBlock | UiFieldsBlock {
  return block.type === 'choices' || block.type === 'fields';
}

function duplicates(ids: string[]): string[] {
  return ids.filter((id, index) => ids.indexOf(id) !== index);
}

export const uiDocSchema = z
  .object({
    version: z.literal(1),
    title: oneLine(80).optional(),
    blocks: z.array(uiBlockSchema).min(1).max(MAX_UI_BLOCKS),
    /**
     * Forward compatibility: the server stores `uiDocToText(doc)` here. A client that meets a block `type` it does
     * not know (or cannot decode the doc at all) MUST show this text instead of dropping the card. Set by the server;
     * whatever a model sends is overwritten, and it does not count toward the size limit.
     */
    text: z.string().max(MAX_UI_DOC_BYTES).optional(),
  })
  .superRefine((doc, ctx) => {
    const interactive = doc.blocks.filter(isInteractiveBlock);
    if (interactive.length > 1) {
      ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'at most one interactive block (choices or fields) per doc: ask one decision per question' });
    }
    for (const block of interactive) {
      const ids = block.type === 'choices' ? block.options.map((option) => option.id) : block.fields.map((field) => field.id);
      const clash = duplicates([block.id, ...ids]);
      if (clash.length > 0) ctx.addIssue({ code: 'custom', path: ['blocks'], message: `ids must be unique, repeated: ${[...new Set(clash)].join(', ')}` });
    }
    const shown = doc.blocks.reduce((count, block) => count + (block.type === 'group' ? 1 + block.blocks.length : 1), 0);
    if (shown > MAX_UI_BLOCKS) {
      ctx.addIssue({ code: 'custom', path: ['blocks'], message: `at most ${MAX_UI_BLOCKS} blocks in all, counting the blocks inside groups (this doc has ${shown})` });
    }
    const { text: _fallback, ...authored } = doc;
    if (new TextEncoder().encode(JSON.stringify(authored)).length > MAX_UI_DOC_BYTES) {
      ctx.addIssue({ code: 'custom', path: [], message: `the doc is over ${MAX_UI_DOC_BYTES / 1024} KB: cut rows or shorten values` });
    }
  });
export type UiDoc = z.infer<typeof uiDocSchema>;

/** The interactive block of a doc, if any. */
export function uiInteractiveBlock(doc: UiDoc): UiChoicesBlock | UiFieldsBlock | undefined {
  return doc.blocks.find(isInteractiveBlock);
}

/** The zod issues of a failed parse as one short, model-readable line per problem. */
export function describeUiIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.length === 0 ? 'ui' : 'ui.' + issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

function groupHint(input: unknown): string | undefined {
  const blocks = (input as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    const inner = (block as { type?: unknown; blocks?: unknown } | null);
    if (inner?.type !== 'group' || !Array.isArray(inner.blocks)) continue;
    const bad = inner.blocks.find((child) => ['group', 'choices', 'fields'].includes((child as { type?: string } | null)?.type ?? ''));
    if (bad !== undefined) return 'a group holds display blocks only (text, facts, items, table, notice, link, image): no nested group, choices or fields; put the choices or fields block at the top level';
  }
  return undefined;
}

/** The doc with its text fallback filled in (see `uiDocSchema`). */
export function withFallbackText(doc: UiDoc): UiDoc {
  const { text: _old, ...rest } = doc;
  return { ...rest, text: uiDocToText(doc) };
}

/**
 * Parse a doc for a context: a `question` must hold exactly one interactive block, a plain `message` none
 * (an answer has nowhere to go from a message). Returns the doc or a message the model can act on.
 */
export function parseUiDoc(input: unknown, context: 'message' | 'question'): { ok: true; doc: UiDoc } | { ok: false; error: string } {
  const parsed = uiDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: groupHint(input) ?? describeUiIssues(parsed.error) };
  const interactive = parsed.data.blocks.filter(isInteractiveBlock).length;
  if (context === 'question' && interactive !== 1) {
    return { ok: false, error: 'a question needs exactly one interactive block: a choices block (pick one or several) or a fields block (non-secret input)' };
  }
  if (context === 'message' && interactive > 0) {
    return { ok: false, error: 'choices and fields blocks only work in kind "question"; a plain message cannot be answered' };
  }
  return { ok: true, doc: withFallbackText(parsed.data) };
}

// --- Text fallback ----------------------------------------------------------

const TONE_LABEL = { info: 'Note', warning: 'Warning', success: 'Done' } as const;

function tableLines(columns: string[], rows: string[][]): string[] {
  const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => (row[index] ?? '').length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return [line(columns), ...rows.map(line)];
}

function blockLines(block: UiBlock | UiLeafBlock): string[] {
  switch (block.type) {
    case 'group':
      return [...(block.title === undefined ? [] : [block.title]), ...block.blocks.flatMap(blockLines).map((line) => `  ${line}`)];
    case 'text':
      return [block.text];
    case 'facts':
      return block.rows.map((row) => `${row.label}: ${row.value}`);
    case 'items': {
      const lines = block.rows.map((row) => {
        const parts = [`• ${row.name}`];
        if (row.detail !== undefined) parts.push(` — ${row.detail}`);
        if (row.quantity !== undefined) parts.push(` ×${row.quantity}`);
        if (row.price !== undefined) parts.push(` ${row.price}`);
        return parts.join('');
      });
      return block.total === undefined ? lines : [...lines, `${block.total.label}: ${block.total.value}`];
    }
    case 'table':
      return tableLines(block.columns, block.rows);
    case 'notice':
      return [`${TONE_LABEL[block.tone]}: ${block.text}`];
    case 'link':
      return [block.subtitle === undefined ? `${block.title}: ${block.url}` : `${block.title} (${block.subtitle}): ${block.url}`];
    case 'image':
      return [block.caption === undefined ? '[Image]' : `[Image: ${block.caption}]`];
    case 'replies':
      return [`Replies: ${block.options.join(' / ')}`];
    case 'choices':
      return [`Options: ${block.options.map((option) => option.label).join(' / ')}${block.multiple === true ? ' (choose any)' : ''}`];
    case 'fields':
      return [`Fields: ${block.fields.map((field) => (field.required === false ? `${field.label} (optional)` : field.label)).join(', ')}`];
  }
}

/**
 * Deterministic plain-text rendering of a doc: the title, a blank line, then each block as readable lines
 * (facts "Label: value", items "• name — detail ×qty price", a table as aligned columns, choices
 * "Options: A / B"). This is what the model sees in its transcript, and what notifications show.
 */
export function uiDocToText(doc: UiDoc): string {
  const body = doc.blocks.flatMap(blockLines).join('\n');
  return doc.title === undefined ? body : `${doc.title}\n\n${body}`;
}

// --- Answers ----------------------------------------------------------------

export type UiAnswerValidation = { ok: true } | { errors: Record<string, string> };

const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}

function checkField(field: UiField, value: string): string | undefined {
  switch (field.kind) {
    case 'number':
      return DECIMAL.test(value) ? undefined : 'Enter a number';
    case 'date':
      return DATE.test(value) && isRealDate(value) ? undefined : 'Enter a date as YYYY-MM-DD';
    case 'select':
      return field.options?.includes(value) ? undefined : `Must be one of: ${(field.options ?? []).join(', ')}`;
    default:
      return value.length > 1000 ? 'Must be at most 1000 characters' : undefined;
  }
}

/**
 * Check a question's answers against its interactive block. Answers are strings keyed by id:
 * - `choices`: key = the block id; value = one option id, or for `multiple` a JSON array string of option ids;
 * - `fields`: key = each field id; value = text as typed, a decimal for `number`, `YYYY-MM-DD` for `date`, one of
 *   the `options` for `select`. A field with `required !== false` must be non-empty.
 * Keys that are not ids of the block are errors. Shared so clients can validate as typed.
 */
export function validateUiAnswers(doc: UiDoc, answers: Record<string, string> | undefined): UiAnswerValidation {
  const block = uiInteractiveBlock(doc);
  const errors: Record<string, string> = {};
  if (block === undefined) return { errors: { '': 'This request has nothing to answer' } };
  const given = answers ?? {};
  const known = new Set(block.type === 'choices' ? [block.id] : block.fields.map((field) => field.id));
  for (const key of Object.keys(given)) if (!known.has(key)) errors[key] = 'Unknown answer id';
  if (block.type === 'choices') {
    const value = (given[block.id] ?? '').trim();
    const ids = new Set(block.options.map((option) => option.id));
    if (value.length === 0) errors[block.id] = 'Required';
    else if (block.multiple === true) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = undefined;
      }
      if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((id) => typeof id === 'string' && ids.has(id))) {
        errors[block.id] = `Choose one or more of: ${[...ids].join(', ')} (a JSON array of option ids)`;
      }
    } else if (!ids.has(value)) errors[block.id] = `Must be one of: ${[...ids].join(', ')}`;
  } else {
    for (const field of block.fields) {
      const value = (given[field.id] ?? '').trim();
      if (value.length === 0) {
        if (field.required !== false) errors[field.id] = 'Required';
        continue;
      }
      const problem = checkField(field, value);
      if (problem) errors[field.id] = problem;
    }
  }
  return Object.keys(errors).length === 0 ? { ok: true } : { errors };
}
