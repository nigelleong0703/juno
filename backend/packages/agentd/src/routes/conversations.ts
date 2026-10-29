import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { ComposerPayload, Conversation } from '@agent-desktop/public-contracts';
import { composerPayloadSchema, updateConversationInputSchema } from '@agent-desktop/public-contracts';
import { sessionKey, wakeEventSchema } from '@agent-desktop/contracts';
import { getOwnerId } from '../auth.js';
import { parseListQueryWithWhere } from './query-helpers.js';
import type { AgentdDeps } from './index.js';
import { deleteConversationCascade } from './conversation-delete.js';
import { admitUserMessage, firstMessageViolation, idempotentConversationId, idempotentMessageId, missingAttachment, withKeyLock } from './message-admission.js';
import { routinesDeliveringTo } from 'juno-agent/execution/harness/services/routineTimer-delivery';
import { withLiveActivity } from 'juno-agent/execution/conversation-activity';
import { resultIdsForHistory } from 'juno-agent/modules/tasks/routines/results';
import {
  isAgentVisible,
  isConversationVisible,
  isRelationshipError,
  listAll,
  paginateFiltered,
  resolveConversationMembers,
} from './relationships.js';

export function registerConversations(app: Hono, deps: AgentdDeps) {
  app.get('/v1/conversations', async (c) => {
    const ownerId = getOwnerId(c);
    const query = c.req.query();
    const agentFilter = query['agentId'];
    if (agentFilter !== undefined && agentFilter !== '') {
      const agent = await deps.store.get('agents', agentFilter);
      if (!agent) {
        return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent ' + agentFilter + ' not found' } }, 404);
      }
      if (!isAgentVisible(agent, ownerId)) {
        return c.json({ error: { code: 'AGENT_FORBIDDEN', message: 'Agent not shared with you' } }, 403);
      }
    }
    const loaded = await listAll(deps.store, 'conversations');
    if (loaded.truncated) {
      return c.json({ error: { code: 'LIST_TRUNCATED', message: 'Conversation list truncated; retry later' } }, 500);
    }
    const kindFilter = query['kind'];
    const memberFilter = query['memberId'];
    const visible: Conversation[] = [];
    for (const conv of loaded.items) {
      if (!isConversationVisible(conv, ownerId)) continue;
      if (agentFilter !== undefined && agentFilter !== '' && !conv.agentIds.includes(agentFilter)) continue;
      if (kindFilter !== undefined && kindFilter !== '' && conv.kind !== kindFilter) continue;
      if (memberFilter !== undefined && memberFilter !== '' && !conv.memberIds.includes(memberFilter)) continue;
      visible.push(conv);
    }
    const page = paginateFiltered(visible, query['limit'], query['cursor']);
    const items = await Promise.all(page.items.map((conv) => withLiveActivity(deps.store, conv)));
    return c.json({ items, nextCursor: page.nextCursor ?? null });
  });

  app.get('/v1/conversations/:id', async (c) => {
    const ownerId = getOwnerId(c);
    const conv = await deps.store.get('conversations', c.req.param('id'));
    if (!conv) {
      return c.json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation ' + c.req.param('id') + ' not found' } }, 404);
    }
    if (!isConversationVisible(conv, ownerId)) {
      return c.json({ error: { code: 'CONVERSATION_FORBIDDEN', message: 'Conversation not shared with you' } }, 403);
    }
    return c.json(await withLiveActivity(deps.store, conv));
  });

  app.post(
    '/v1/conversations',
    zValidator(
      'json',
      z.object({
        kind: z.enum(['direct', 'room', 'task']),
        memberAgentIds: z.array(z.string()),
        title: z.string().optional(),
        roomMode: z.enum(['mention', 'open_floor']).optional(),
        hostAgentId: z.string().optional(),
        firstMessage: z.unknown().optional(),
        requestId: z.string().min(1).optional(),
      })
    ),
    async (c) => {
      const ownerId = getOwnerId(c);
      const input = c.req.valid('json');
      // A client requestId (body) or Idempotency-Key (header, forwarded verbatim by the gateway)
      // lets a retry after a partial failure resolve to the same conversation and re-attempt the
      // same wake instead of creating a duplicate thread.
      const headerKey = c.req.header('Idempotency-Key');
      if (input.requestId !== undefined && headerKey !== undefined && headerKey !== input.requestId) {
        return c.json({ error: { code: 'REQUEST_ID_MISMATCH', message: 'requestId and Idempotency-Key disagree' } }, 400);
      }
      const idempotencyKey = input.requestId ?? headerKey;
      let firstMessage: ComposerPayload | undefined;
      if (input.firstMessage !== undefined) {
        const parsed = composerPayloadSchema.safeParse(input.firstMessage);
        if (!parsed.success) {
          return c.json({ error: { code: 'INVALID_MESSAGE', message: 'Invalid first message payload' } }, 400);
        }
        firstMessage = parsed.data;
      }
      const members = await resolveConversationMembers(deps.store, ownerId, input.memberAgentIds);
      if (isRelationshipError(members)) {
        return c.json({ error: { code: members.code, message: members.message } }, members.status);
      }
      if (input.hostAgentId !== undefined && !members.memberAgentIds.includes(input.hostAgentId)) {
        return c.json({ error: { code: 'HOST_NOT_MEMBER', message: 'Host agent is not a conversation member' } }, 400);
      }
      const id = idempotencyKey ? idempotentConversationId(ownerId, idempotencyKey) : 'cvn-' + randomUUID();
      const now = new Date().toISOString();
      const conv: Conversation & { ownerId: string } = {
        id,
        kind: input.kind,
        title: input.title || (input.kind === 'direct' ? undefined : 'New room'),
        agentIds: members.memberAgentIds,
        memberIds: [ownerId],
        roomMode: input.roomMode,
        hostAgentId: input.hostAgentId,
        unreadCount: 0,
        lastItemAt: now,
        createdAt: now,
        ownerId,
      };
      if (firstMessage !== undefined) {
        const violation = firstMessageViolation(conv, firstMessage) ?? (await missingAttachment(deps, ownerId, firstMessage.attachments ?? []));
        if (violation !== undefined) {
          return c.json({ error: { code: violation.code, message: violation.message } }, violation.status);
        }
      }
      const createAndAdmit = async () => {
        const existing = await deps.store.get('conversations', id);
        const created = existing ?? (await deps.store.put('conversations', conv));
        if (!existing) {
          await deps.store.emit({ type: 'conversation.created', conversation: created });
        }
        if (firstMessage === undefined) return { created, admitted: undefined };
        const messageId = idempotencyKey ? idempotentMessageId(ownerId, idempotencyKey) : undefined;
        return { created, admitted: await admitUserMessage(deps, created, ownerId, firstMessage, { messageId }) };
      };
      // E64: same-key creates queue so the second sees the first's rows.
      const { created, admitted } = idempotencyKey ? await withKeyLock('conversations:' + id, createAndAdmit) : await createAndAdmit();
      if (admitted !== undefined && !admitted.ok) {
        return c.json({ error: { code: admitted.error.code, message: admitted.error.message } }, admitted.error.status);
      }
      return c.json(created, 201);
    }
  );

  /**
   * Pin or mute one chat. The flags live on the conversation row: the owner is the only user today,
   * so a group room has one shared pinned/muted state. Emits `conversation.updated` for other tabs.
   */
  app.patch('/v1/conversations/:id', zValidator('json', updateConversationInputSchema), async (c) => {
    const ownerId = getOwnerId(c);
    const existing = await deps.store.get('conversations', c.req.param('id'));
    if (!existing) {
      return c.json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation ' + c.req.param('id') + ' not found' } }, 404);
    }
    if (!isConversationVisible(existing, ownerId)) {
      return c.json({ error: { code: 'CONVERSATION_FORBIDDEN', message: 'Conversation not shared with you' } }, 403);
    }
    const conv = await withLiveActivity(deps.store, await deps.store.patch('conversations', existing.id, c.req.valid('json')));
    await deps.store.emit({ type: 'conversation.updated', conversation: conv });
    return c.json(conv);
  });

  app.delete('/v1/conversations/:id', async (c) => {
    const result = await deleteConversationCascade(deps, getOwnerId(c), c.req.param('id'));
    if (!result.ok) return c.json({ error: { code: result.code, message: result.message } }, result.status);
    return c.json({});
  });

  app.get('/v1/conversations/:id/items', async (c) => {
    const ownerId = getOwnerId(c);
    const conv = await deps.store.get('conversations', c.req.param('id'));
    if (!conv) {
      return c.json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' } }, 404);
    }
    if (!isConversationVisible(conv, ownerId)) {
      return c.json({ error: { code: 'CONVERSATION_FORBIDDEN', message: 'Conversation not shared with you' } }, 403);
    }
    const convId = c.req.param('id');
    const query = parseListQueryWithWhere(c.req.query(), ['agentId', 'conversationId', 'runId', 'status', 'kind', 'parentId', 'ids']);
    const page = await deps.store.list('items', {
      ...query,
      // A36: transcript rows must read in timeline order by default. The store
      // falls back to id order when no orderBy is given, which once listed a
      // 14:54:42 greeting after a 14:54:56 reply. Explicit params still win.
      orderBy: query.orderBy ?? 'at',
      order: query.order ?? 'asc',
      where: { ...query.where, conversationId: convId },
    });
    return c.json({ items: page.items, nextCursor: page.nextCursor });
  });


  /**
   * Best-effort typing ping for a private chat: while the user is composing, the agent holds back its
   * start and its ready reply; `active: false` (sent, cleared, left) lets it go on a second later. It
   * never wakes an agent and never stores an item. Rooms are mention-only, so a room ping is a no-op.
   */
  app.post('/v1/conversations/:id/typing', async (c) => {
    const convId = c.req.param('id');
    const ownerId = getOwnerId(c);
    const conv = await deps.store.get('conversations', convId);
    if (!conv) {
      return c.json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation ' + convId + ' not found' } }, 404);
    }
    if (!isConversationVisible(conv, ownerId)) {
      return c.json({ error: { code: 'CONVERSATION_FORBIDDEN', message: 'Conversation not shared with you' } }, 403);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: { code: 'INVALID_BODY', message: 'Request body must be JSON' } }, 400);
    }
    const parsed = z.object({ active: z.boolean() }).safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_BODY', message: 'Typing body must be { active: boolean }' } }, 400);
    }
    if (conv.kind !== 'direct' && conv.kind !== 'peer') return c.body(null, 204);
    const agentId = conv.agentIds[0];
    if (agentId === undefined) return c.body(null, 204);
    const agent = await deps.store.get('agents', agentId);
    if (!agent || !isAgentVisible(agent, ownerId)) {
      return c.json({ error: { code: 'AGENT_FORBIDDEN', message: 'Agent not shared with you' } }, 403);
    }
    const wake = wakeEventSchema.parse({
      id: 'wk-type-' + convId + '-' + randomUUID(),
      ownerId,
      agentId,
      sessionKey: sessionKey(agentId, convId),
      conversationId: convId,
      kind: 'typing',
      origin: { type: 'user', id: ownerId },
      trusted: false,
      priority: 'background',
      payload: { active: parsed.data.active },
      at: new Date().toISOString(),
    });
    // Best-effort: a dropped ping only means the agent may not wait for them, so it never fails the client.
    try {
      await deps.enqueuer.enqueue(wake);
    } catch {
      return c.body(null, 204);
    }
    return c.body(null, 204);
  });

  app.post('/v1/conversations/:id/mark-read', async (c) => {
    const ownerId = getOwnerId(c);
    const existing = await deps.store.get('conversations', c.req.param('id'));
    if (!existing) {
      return c.json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' } }, 404);
    }
    if (!isConversationVisible(existing, ownerId)) {
      return c.json({ error: { code: 'CONVERSATION_FORBIDDEN', message: 'Conversation not shared with you' } }, 403);
    }
    // One timestamp for both: the unread count is everything newer than it, and the routine read
    // evidence below uses it as the cutoff, so the badge and the auto-pause agree.
    const readCutoff = new Date().toISOString();
    const conv = await withLiveActivity(deps.store, await deps.store.patch('conversations', c.req.param('id'), { lastReadAt: readCutoff }));
    // Other tabs clear their badge from this snapshot.
    await deps.store.emit({ type: 'conversation.updated', conversation: conv });
    try {
      const routines = await routinesDeliveringTo(deps.store, c.req.param('id'));
      for (const routine of routines) {
        const agent = await deps.store.get('agents', routine.agentId);
        if (agent === null || !isAgentVisible(agent, ownerId)) continue;
        await deps.enqueuer.routineResultsRead?.({
          routineId: routine.id,
          conversationId: c.req.param('id'),
          readCutoff,
          resultIds: resultIdsForHistory(routine, readCutoff),
        });
      }
    } catch {
      // Best-effort read evidence: lastReadAt above already cleared the unread count.
    }
    return c.json(conv);
  });
}
