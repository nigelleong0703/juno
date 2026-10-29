import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Doc, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { checkMembership } from './transcriptRead.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const SNIPPET_CHARS = 300;

const schema = z.object({
  query: z.string().trim().min(1),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** The visible words of one chat item: the user's text or the agent's reply; any other item type is not a message. */
function messageOf(item: Doc<'items'>): { role: string; text: string } | undefined {
  if (item.type === 'user_message') return { role: 'user', text: item.text };
  if (item.type === 'agent_message') return { role: 'agent', text: item.markdown };
  return undefined;
}

function snippet(text: string, word: string): string {
  const start = Math.max(0, text.toLowerCase().indexOf(word) - SNIPPET_CHARS / 3);
  const cut = text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '') + cut + (start + SNIPPET_CHARS < text.length ? '…' : '');
}

export function createTranscriptSearchTool(): Tool {
  return {
    name: 'transcript_search',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '' },
        after: { type: 'string', description: '' },
        before: { type: 'string', description: '' },
        limit: { type: 'number', description: '' },
      },
      required: ['query'],
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return invalidArguments('transcript_search', args, parsed.error);
      const { query, after, before } = parsed.data;
      const afterMs = after === undefined ? -Infinity : Date.parse(after);
      const beforeMs = before === undefined ? Infinity : Date.parse(before);
      if (Number.isNaN(afterMs) || Number.isNaN(beforeMs)) return toolError('Invalid after/before: expected an ISO date or datetime.');
      const membership = await checkMembership(ctx.store, ctx);
      if (membership) return toolError(membership);
      const words = query.toLowerCase().split(/\s+/);
      const longest = words.reduce((best, word) => (word.length > best.length ? word : best), '');
      const limit = parsed.data.limit ?? DEFAULT_LIMIT;
      const hits: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < MAX_PAGES && hits.length < limit; pages += 1) {
        const page = await ctx.store.list('items', { where: { conversationId: ctx.conversationId }, orderBy: 'at', order: 'desc', limit: PAGE_SIZE, cursor });
        for (const item of page.items) {
          const message = messageOf(item);
          const at = Date.parse(item.at);
          if (message === undefined || item.conversationId !== ctx.conversationId || at < afterMs || at >= beforeMs) continue;
          const lower = message.text.toLowerCase();
          if (!words.every((word) => lower.includes(word)) || hits.length >= limit) continue;
          hits.push(`[${item.at}] ${item.id} ${message.role}: ${snippet(message.text, longest)}`);
        }
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
      const text = hits.length === 0
        ? `No messages containing "${query}" in this conversation${after || before ? ' in that time range' : ''}.`
        : [`${hits.length} message(s) containing "${query}", newest first. Read one in full with transcript_read around = its time.`, ...hits].join('\n');
      return { content: [{ type: 'text', text }], details: { hits: hits.length } };
    },
  };
}
