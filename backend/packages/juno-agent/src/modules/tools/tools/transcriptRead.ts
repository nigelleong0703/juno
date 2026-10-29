import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import { sessionKey as buildSessionKey } from '../../../contracts/index.js';
import { buildRoomHistory } from '../../../execution/brain/room-history.js';
import { readTranscript } from '../../../execution/brain/transcript.js';
import type { Store, Tool, ToolContext, ToolResult, TranscriptEntry } from '../../../contracts/index.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const AROUND_WINDOW = 40;
const MAX_ENTRY_CHARS = 4000;
const MAX_TOOL_ARGS_CHARS = 300;

const rangeSchema = z.object({
  from: z.number().int().min(0).optional(),
  to: z.number().int().min(0).optional(),
});

const transcriptReadSchema = z.object({
  sessionKey: z.string().min(1).optional(),
  range: rangeSchema.optional(),
  around: z.string().min(1).optional(),
});

function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function partText(part: unknown): string | null {
  if (!isRecord(part)) return null;
  if (part.type === 'text') return asString(part.text);
  if (part.type === 'image') return '[image]';
  return null;
}

function contentText(content: unknown): string {
  const direct = asString(content);
  if (direct !== null) return direct;
  if (Array.isArray(content)) {
    const bits: string[] = [];
    for (const part of content) {
      const text = partText(part);
      if (text !== null) bits.push(text);
    }
    return bits.join('\n');
  }
  return '';
}

function toolCallLine(part: Record<string, unknown>): string {
  const name = asString(part.name) ?? 'unknown';
  const rawArgs = isRecord(part.arguments) ? JSON.stringify(part.arguments) : null;
  if (!rawArgs) return `[tool call ${name}]`;
  const args = rawArgs.length > MAX_TOOL_ARGS_CHARS ? `${rawArgs.slice(0, MAX_TOOL_ARGS_CHARS)}\u2026` : rawArgs;
  return `[tool call ${name} ${args}]`;
}

function serializeMessage(message: Record<string, unknown>): { role: string; text: string } {
  const role = asString(message.role) ?? 'unknown';
  if (role === 'assistant' && Array.isArray(message.content)) {
    const bits: string[] = [];
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      if (part.type === 'thinking') continue;
      if (part.type === 'toolCall') {
        bits.push(toolCallLine(part));
        continue;
      }
      const text = partText(part);
      if (text !== null && text !== '') bits.push(text);
    }
    return { role, text: bits.join('\n') };
  }
  if (role === 'toolResult') {
    const name = asString(message.toolName) ?? 'tool';
    const label = message.isError === true ? `(error) ${name}` : name;
    const body = contentText(message.content);
    return { role, text: body === '' ? label : `${label}: ${body}` };
  }
  return { role, text: contentText(message.content) };
}

function formatEntry(entry: TranscriptEntry): string {
  const rendered = serializeMessage(entry.message);
  const body =
    rendered.text.length > MAX_ENTRY_CHARS ? `${rendered.text.slice(0, MAX_ENTRY_CHARS)}\u2026 (truncated)` : rendered.text;
  return `[${entry.seq}] ${rendered.role}: ${body}`;
}

export async function checkMembership(store: Store, ctx: ToolContext): Promise<string | null> {
  const conversation = await store.get('conversations', ctx.conversationId);
  if (!conversation) return null;
  if (conversation.agentIds.includes(ctx.agentId)) return null;
  return `Refused: agent "${ctx.agentId}" is not a participant of conversation "${ctx.conversationId}".`;
}

export function createTranscriptReadTool(_opts: { store: Store }): Tool {
  return {
    name: 'transcript_read',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        sessionKey: {
          type: 'string',
          description: '',
        },
        around: { type: 'string', description: '' },
        range: {
          type: 'object',
          properties: {
            from: { type: 'number', description: '' },
            to: { type: 'number', description: '' },
          },
        },
      },
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = transcriptReadSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('transcript_read', args, parsed.error);
      const aroundMs = parsed.data.around === undefined ? undefined : Date.parse(parsed.data.around);
      if (aroundMs !== undefined && Number.isNaN(aroundMs)) return toolError(`Invalid around "${parsed.data.around}": expected an ISO date or datetime.`);
      let from = parsed.data.range?.from ?? 0;
      let to = parsed.data.range?.to ?? from + DEFAULT_LIMIT;
      if (to < from) {
        return toolError(
          `Invalid range: "to" (${to}) must not be less than "from" (${from}). ` +
            'Positions are 0-based, "from" inclusive and "to" exclusive.',
        );
      }
      const currentKey = ctx.wake.sessionKey || buildSessionKey(ctx.agentId, ctx.conversationId);
      const requestedKey = parsed.data.sessionKey;
      if (requestedKey !== undefined && requestedKey !== currentKey) {
        return toolError(
          `Refused to read session "${requestedKey}": transcript_read can only read the current session ("${currentKey}").`,
        );
      }
      const room = await buildRoomHistory(ctx.store, { agentId: ctx.agentId, conversationId: ctx.conversationId, sessionKey: currentKey, wake: ctx.wake, ...(parsed.data.range === undefined ? {} : { range: { from, to } }) });
      if (room.ok) return { content: [{ type: 'text', text: room.text }], details: { sessionKey: currentKey, ...room.details } };
      if (!room.notRoom) return toolError(room.error);
      const membership = await checkMembership(ctx.store, ctx);
      if (membership) return toolError(membership);
      const entries = await readTranscript(ctx.store, currentKey);
      const total = entries.length;
      if (aroundMs !== undefined && parsed.data.range === undefined && total > 0) {
        const hit = entries.findIndex((entry) => Date.parse(entry.at) >= aroundMs);
        from = Math.max(0, hit < 0 ? total - AROUND_WINDOW : hit - AROUND_WINDOW / 2);
        to = from + AROUND_WINDOW;
      }
      if (total === 0) {
        return {
          content: [{ type: 'text', text: `No transcript entries for session "${currentKey}" yet.` }],
          details: { sessionKey: currentKey, total, from, to: from, hasMore: false },
        };
      }
      const end = Math.min(to, from + MAX_LIMIT, total);
      const slice = entries.slice(from, end);
      if (slice.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No entries in positions ${from}..${end} for session "${currentKey}" (${total} total).`,
            },
          ],
          details: { sessionKey: currentKey, total, from, to: end, hasMore: false },
        };
      }
      const lines = slice.map((entry) => formatEntry(entry));
      const hasMore = end < total;
      let header = `Transcript "${currentKey}": showing ${slice.length} of ${total} entries (positions ${from}..${end}).`;
      if (to - from > MAX_LIMIT) header += ` Range capped at ${MAX_LIMIT} entries per call.`;
      if (hasMore) header += ` More entries remain; continue with range { "from": ${end} }.`;
      return {
        content: [{ type: 'text', text: [header, ...lines].join('\n') }],
        details: { sessionKey: currentKey, total, from, to: end, hasMore, nextFrom: hasMore ? end : undefined },
      };
    },
  };
}
