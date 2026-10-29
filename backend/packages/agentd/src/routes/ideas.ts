import { type Context, type Hono } from 'hono';
import type { Conversation, Idea } from '@agent-desktop/public-contracts';
import { ideaStatusSchema } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { admitUserMessage, idempotentConversationId, idempotentMessageId, withKeyLock } from './message-admission.js';
import { docOwnerId, isRelationshipError, listAll, paginateFiltered, resolveConversationMembers } from './relationships.js';

/** The caller's own row, or undefined: another owner's row answers exactly like a missing one. */
async function ownRow(deps: AgentdDeps, c: Context): Promise<Idea | undefined> {
  const row = await deps.store.get('ideas', c.req.param('id') ?? '');
  return row !== null && docOwnerId(row) === getOwnerId(c) ? row : undefined;
}

/**
 * Ideas offered to the user. Accepting does the idea: it starts a run of the idea's agent in a new conversation, with the idea's
 * prompt as the first message, and records that conversation on the idea. Dismissing only records the user's answer; the daily
 * ideas job reads dismissed ideas and does not offer the same thing again for 14 days (BACKEND §5.10).
 */
export function registerIdeas(app: Hono, deps: AgentdDeps) {
  const dismiss = async (c: Context) => {
    const row = await ownRow(deps, c);
    if (row === undefined) return c.json({ error: { code: 'IDEA_NOT_FOUND', message: 'Idea not found' } }, 404);
    const updated = await deps.store.patch('ideas', row.id, { status: 'dismissed', updatedAt: new Date().toISOString() });
    await deps.store.emit({ type: 'idea.updated', idea: updated });
    return c.json(updated);
  };

  const accept = async (c: Context) => {
    const ownerId = getOwnerId(c);
    const row = await ownRow(deps, c);
    if (row === undefined) return c.json({ error: { code: 'IDEA_NOT_FOUND', message: 'Idea not found' } }, 404);
    // Two taps (or a retry) start one conversation: the id comes from the idea and the lock serialises the writes.
    return withKeyLock('idea-accept:' + row.id, async () => {
      const current = (await deps.store.get('ideas', row.id)) ?? row;
      if (current.conversationId !== undefined) return c.json(current);
      const action = current.action ?? { agentId: current.agentId, prompt: current.prompt };
      const members = await resolveConversationMembers(deps.store, ownerId, [action.agentId]);
      if (isRelationshipError(members)) return c.json({ error: { code: members.code, message: members.message } }, members.status);
      const id = idempotentConversationId(ownerId, 'idea-' + current.id);
      const now = new Date().toISOString();
      const conv: Conversation & { ownerId: string } = {
        id, kind: 'direct', title: current.text, agentIds: members.memberAgentIds, memberIds: [ownerId],
        unreadCount: 0, lastItemAt: now, createdAt: now, ownerId,
      };
      const existing = await deps.store.get('conversations', id);
      const created = existing ?? (await deps.store.put('conversations', conv));
      if (existing === null) await deps.store.emit({ type: 'conversation.created', conversation: created });
      const admitted = await admitUserMessage(deps, created, ownerId, { text: action.prompt }, { messageId: idempotentMessageId(ownerId, 'idea-' + current.id) });
      if (!admitted.ok) return c.json({ error: { code: admitted.error.code, message: admitted.error.message } }, admitted.error.status);
      const updated = await deps.store.patch('ideas', current.id, { status: 'accepted', conversationId: id, updatedAt: new Date().toISOString() });
      await deps.store.emit({ type: 'idea.updated', idea: updated });
      return c.json(updated);
    });
  };

  app.get('/v1/ideas', async (c) => {
    const ownerId = getOwnerId(c);
    const query = c.req.query();
    const status = query['status'] === undefined ? undefined : ideaStatusSchema.safeParse(query['status']);
    if (status !== undefined && !status.success) {
      return c.json({ error: { code: 'INVALID_STATUS', message: 'status must be open, accepted or dismissed' } }, 400);
    }
    const loaded = await listAll(deps.store, 'ideas');
    if (loaded.truncated) {
      return c.json({ error: { code: 'LIST_TRUNCATED', message: 'Idea list truncated; retry later' } }, 500);
    }
    const own = loaded.items
      .filter((row) => docOwnerId(row) === ownerId)
      .filter((row) => query['agentId'] === undefined || row.agentId === query['agentId'])
      .filter((row) => status === undefined || row.status === status.data)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const page = paginateFiltered(own, query['limit'], query['cursor']);
    return c.json({ items: page.items, nextCursor: page.nextCursor ?? null });
  });

  app.post('/v1/ideas/:id/accept', accept);
  app.post('/v1/ideas/:id/dismiss', dismiss);
}
