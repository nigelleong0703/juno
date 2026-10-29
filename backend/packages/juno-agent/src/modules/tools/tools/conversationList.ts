/**
 * conversation_list: the requesting agent's own conversation memberships.
 *
 * An authorized projection of membership — never a second copied mutable
 * conversation array. Each entry must clear two checks: the requester listed in memberIds, and every agent member
 * inside the requester's own graph. Known foreign conversations are withheld.
 * Returns ids, kind, title, member ids and current routing only; item content
 * is never read and never returned. Stored titles are quoted and bounded so
 * they read as data, never instructions.
 */
import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import {
  clampLimit,
  paginateAuthorized,
  quoteLabel,
  readString,
  readStringArray,
  requireRequesterContext,
  type RequesterContext,
} from './relationPolicy.js';

const conversationListSchema = z.object({
  limit: z.number().optional(),
  cursor: z.string().optional(),
});

export interface ConversationSummary {
  id: string;
  kind: string;
  title?: string;
  agentIds: string[];
  memberIds: string[];
  sessionKey: string;
  roomMode?: string;
  hostAgentId?: string;
}

async function isOwnConversation(store: Store, doc: unknown, requester: RequesterContext): Promise<boolean> {
  const memberIds = readStringArray(doc, 'memberIds') ?? [];
  if (!memberIds.includes(requester.ownerId)) return false;
  const agentIds = readStringArray(doc, 'agentIds') ?? [];
  for (const id of agentIds) {
    let member: unknown;
    try {
      member = await store.get('agents', id);
    } catch {
      return false;
    }
    if (member === null) return false;
    const owner = readString(member, 'ownerId') ?? readString(member, 'createdBy');
    if (owner !== requester.ownerId) return false;
  }
  return true;
}

function toSummary(doc: unknown, selfAgentId: string): ConversationSummary | undefined {
  const id = readString(doc, 'id');
  const kind = readString(doc, 'kind');
  const agentIds = readStringArray(doc, 'agentIds') ?? [];
  if (id === undefined || kind === undefined) return undefined;
  if (!agentIds.includes(selfAgentId)) return undefined;
  const summary: ConversationSummary = {
    id,
    kind,
    agentIds,
    memberIds: readStringArray(doc, 'memberIds') ?? [],
    sessionKey: selfAgentId + ':' + id,
  };
  const title = readString(doc, 'title');
  if (title !== undefined) summary.title = title;
  if (kind === 'room') {
    const roomMode = readString(doc, 'roomMode');
    if (roomMode !== undefined) summary.roomMode = roomMode;
    const hostAgentId = readString(doc, 'hostAgentId');
    if (hostAgentId !== undefined) summary.hostAgentId = hostAgentId;
  }
  return summary;
}

export function createConversationListTool(opts: { store: Store }): Tool {
  return {
    name: 'conversation_list',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = conversationListSchema.parse(args);
      const auth = await requireRequesterContext(ctx);
      if (!auth.ok) return { content: [{ type: 'text', text: auth.error }], isError: true };
      const requester: RequesterContext = auth.value;
      const limit = clampLimit(parsed.limit, 20, 50);
      const page = await paginateAuthorized(opts.store, 'conversations', parsed.cursor, limit, async (doc) => {
        const summary = toSummary(doc, ctx.agentId);
        if (summary === undefined) return undefined;
        if (!(await isOwnConversation(opts.store, doc, requester))) return undefined;
        return summary;
      });
      if (!page.ok) return { content: [{ type: 'text', text: page.error }], isError: true };
      const slice = page.value.entries;
      const lines: string[] = [];
      if (slice.length === 0) {
        if (page.value.scanTruncated) {
          lines.push('Conversation scan reached its per-call bound with rows remaining; follow nextCursor to continue. No verdict on further conversations yet.');
        } else {
          lines.push('The current agent is not a listed member of any authorized conversation.');
        }
      } else {
        lines.push('Conversations (' + String(slice.length) + ' shown):');
        for (const summary of slice) {
          const title = summary.title !== undefined ? ' ' + quoteLabel(summary.title) : '';
          lines.push('- ' + summary.id + ' (' + summary.kind + ')' + title + ' via ' + summary.sessionKey);
        }
      }
      if (page.value.nextCursor !== undefined) lines.push('More conversations may remain; pass cursor back for the next page.');
      if (page.value.scanTruncated && slice.length > 0) {
        lines.push('Scan bound hit with rows remaining; the next page continues where this one stopped.');
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          conversations: slice,
          ...(page.value.nextCursor !== undefined ? { nextCursor: page.value.nextCursor } : {}),
          ...(page.value.scanTruncated ? { scanTruncated: true } : {}),
        },
      };
    },
  };
}
