/**
 * conversation_create: agent-created room channels with the user.
 *
 * Creates a kind room conversation whose agents are exactly the sender plus
 * the validated memberAgentIds, and whose human membership is exactly the
 * authenticated requester (memberIds of ownerId). The caller picks agents
 * only: caller-selected users and foreign agents are never honored. Every
 * check runs before any write, and the put plus conversation.created commit
 * atomically through store.tx. The id is deterministic in runId plus the
 * normalized inputs plus the owner so a retried tool call reuses the same record instead of
 * duplicating the room; a colliding unrelated record refuses the overwrite.
 * Creation wakes nobody: an explicit first message is a separate send_message
 * call with this room's conversationId (post_to_room is not model-visible).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { isOwnedAgent, readString, readStringArray, requireRequesterContext } from './relationPolicy.js';
import { nowIso } from '../util.js';

const conversationCreateSchema = z.object({
  title: z.string(),
  memberAgentIds: z.array(z.string()),
  roomMode: z.enum(['mention', 'open_floor']).optional(),
});

/** Maximum agent participants per created room, sender included. */
export const MAX_CONVERSATION_CREATE_AGENTS = 20;

/** Maximum room title length (mirrors the directory label bound). */
export const MAX_CONVERSATION_CREATE_TITLE = 120;

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

interface NormalizedCreate {
  title: string;
  agentIds: string[];
  roomMode: 'mention' | 'open_floor';
}

/**
 * Deterministic room id for one tool call: runId plus the normalized inputs
 * (trimmed title, sorted canonical agent set, room mode). The same retry
 * resolves to the same id; different runs or inputs resolve elsewhere.
 */
export function roomConversationIdForCreate(
  runId: string,
  input: { title: string; agentIds: string[]; roomMode: 'mention' | 'open_floor'; ownerId: string },
): string {
  const canonical = {
    runId,
    ownerId: input.ownerId,
    title: input.title,
    agentIds: [...input.agentIds].sort(),
    roomMode: input.roomMode,
  };
  const digest = createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('base64url');
  return 'room_' + digest;
}

function sameIdSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const known = new Set(left);
  for (const id of right) {
    if (!known.has(id)) return false;
  }
  return true;
}

function normalize(
  parsed: z.infer<typeof conversationCreateSchema>,
  senderId: string,
): NormalizedCreate | { error: string } {
  const title = parsed.title.trim();
  if (title.length === 0) return { error: 'Error: room title required' };
  if (title.length > MAX_CONVERSATION_CREATE_TITLE) {
    return { error: 'Error: room title exceeds ' + String(MAX_CONVERSATION_CREATE_TITLE) + ' characters' };
  }
  const seen = new Set<string>();
  for (const raw of parsed.memberAgentIds) {
    const id = raw.trim();
    if (id.length === 0) return { error: 'Error: member agent ids must be non-empty' };
    seen.add(id);
  }
  seen.add(senderId);
  const agentIds = [...seen];
  if (agentIds.length > MAX_CONVERSATION_CREATE_AGENTS) {
    return {
      error:
        'Error: room member limit exceeded (' +
        String(agentIds.length) +
        ' > ' +
        String(MAX_CONVERSATION_CREATE_AGENTS) +
        ' agents, sender included)',
    };
  }
  return { title, agentIds, roomMode: parsed.roomMode ?? 'mention' };
}

export function createConversationCreateTool(opts: { store: Store }): Tool {
  return {
    name: 'conversation_create',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        memberAgentIds: { type: 'array', items: { type: 'string' } },
        roomMode: { enum: ['mention', 'open_floor'] },
      },
      required: ['title', 'memberAgentIds'],
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = conversationCreateSchema.parse(args);
      const normalized = normalize(parsed, ctx.agentId);
      if ('error' in normalized) return errorResult(normalized.error);
      const auth = await requireRequesterContext(ctx);
      if (!auth.ok) return errorResult(auth.error);
      const requester = auth.value;
      for (const memberId of normalized.agentIds) {
        let member: unknown;
        try {
          member = await opts.store.get('agents', memberId);
        } catch {
          return errorResult('Error: the agent record for ' + memberId + ' is unreadable; nothing was created.');
        }
        if (member === null) {
          return errorResult('Error: agent ' + memberId + ' does not exist; nothing was created.');
        }
        if (!isOwnedAgent(member, requester.ownerId)) {
          return errorResult('Error: agent ' + memberId + ' is outside the owned graph; cross-owner rooms need explicit delegation.');
        }
      }
      const conversationId = roomConversationIdForCreate(ctx.runId, {
        title: normalized.title,
        agentIds: normalized.agentIds,
        roomMode: normalized.roomMode,
        ownerId: requester.ownerId,
      });
      let existing: unknown;
      try {
        existing = await opts.store.get('conversations', conversationId);
      } catch {
        return errorResult('Error: the conversation record is unreadable; nothing was created.');
      }
      if (existing !== null) {
        const kind = readString(existing, 'kind');
        const agentIds = readStringArray(existing, 'agentIds') ?? [];
        const memberIds = readStringArray(existing, 'memberIds') ?? [];
        const valid =
          kind === 'room' &&
          sameIdSet(agentIds, normalized.agentIds) &&
          sameIdSet(memberIds, [requester.ownerId]) &&
          readString(existing, 'title') === normalized.title &&
          (readString(existing, 'roomMode') ?? 'mention') === normalized.roomMode;
        if (!valid) {
          return errorResult('Error: the conversation record ' + conversationId + ' collides with an unrelated conversation; refusing to overwrite it.');
        }
        return {
          content: [{ type: 'text', text: 'Room already exists (' + conversationId + ')' }],
          details: {
            conversationId,
            title: normalized.title,
            memberAgentIds: normalized.agentIds,
            roomMode: normalized.roomMode,
          },
        };
      }
      const now = nowIso();
      const conversation = {
        id: conversationId,
        kind: 'room' as const,
        title: normalized.title,
        agentIds: normalized.agentIds,
        memberIds: [requester.ownerId],
        roomMode: normalized.roomMode,
        hostAgentId: ctx.agentId,
        unreadCount: 0,
        lastItemAt: now,
        createdAt: now,
      };
      try {
        await ctx.step('create_conversation', async () => {
          await opts.store.tx(async (scoped) => {
            await scoped.put('conversations', conversation, { conversationId });
            await scoped.emit({ type: 'conversation.created', conversation });
          });
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult('Error: the room could not be created: ' + msg);
      }
      return {
        content: [
          {
            type: 'text',
            text: 'Created room (' + conversationId + ') with ' + String(normalized.agentIds.length) + ' agent(s)',
          },
        ],
        details: {
          conversationId,
          title: normalized.title,
          memberAgentIds: normalized.agentIds,
          roomMode: normalized.roomMode,
        },
      };
    },
  };
}
