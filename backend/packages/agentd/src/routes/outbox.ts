/**
 * The outbox, the owner's side (BACKEND 5.7.11): what is waiting to leave or was given up on, putting a dropped delivery back once, and the switch that
 * stops all sending. Owner only: the store is the owner's, so another owner's row is simply not found. Message text is never in a row's view.
 */
import { type Context, type Hono } from 'hono';
import { outboxFreezeInputSchema, outboxFreezeSchema, outboxListSchema, outboxQuerySchema, type OutboxEntry } from '@agent-desktop/public-contracts';
import type { OutboxRow } from 'juno-agent/contracts';
import { getOwnerId } from '../auth.js';
import { announceDelivery } from '../outbox/delivery-state.js';
import { operatorFrozen } from '../outbox/sender.js';
import type { AgentdDeps } from './index.js';

/** What the owner sees of a row. */
export function entryOf(row: OutboxRow): OutboxEntry {
  return {
    id: row.id, kind: row.kind, status: row.status, ...(row.conversationId === undefined ? {} : { conversationId: row.conversationId }),
    sourceId: row.sourceId, platform: row.platform, attempts: row.attempts,
    ...(row.status === 'pending' ? { nextAttemptAt: row.nextAttemptAt } : {}),
    ...(row.lastError === undefined ? {} : { lastError: row.lastError }), ...(row.droppedReason === undefined ? {} : { reason: row.droppedReason }),
    createdAt: row.createdAt, ...(row.sentAt === undefined ? {} : { sentAt: row.sentAt }), ...(row.droppedAt === undefined ? {} : { droppedAt: row.droppedAt }),
  };
}

export function registerOutbox(app: Hono, deps: AgentdDeps) {
  const scoped = (c: Context) => deps.store.forOwner?.(getOwnerId(c));
  const unavailable = (c: Context) => c.json({ error: { code: 'OUTBOX_UNAVAILABLE', message: 'the outbox needs an owner-scoped database' } }, 503);

  app.get('/v1/outbox', async (c) => {
    const query = outboxQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: { code: 'INVALID_QUERY', message: 'status is pending or dropped; limit is 1 to 100' } }, 400);
    const store = scoped(c);
    if (store === undefined) return unavailable(c);
    const ownerId = getOwnerId(c);
    const { status, conversationId, cursor, limit } = query.data;
    // Newest first. Sent rows are not listed: the list is what still needs attention.
    const page = await store.list('outbox', {
      where: { ...(status === undefined ? { statuses: ['pending', 'dropped'] } : { status }), ...(conversationId === undefined ? {} : { conversationId }) },
      orderBy: 'at', order: 'desc', limit, ...(cursor === undefined ? {} : { cursor }),
    });
    const control = await store.get('outboxControl', ownerId);
    const health = deps.outbox?.health(ownerId) ?? { status: 'ok' as const, failing: [] };
    return c.json(outboxListSchema.parse({
      items: page.items.map(entryOf),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      frozen: { owner: control?.frozen === true, operator: operatorFrozen(process.env) },
      health: { status: health.status, failing: health.failing.map(({ ownerId: _owner, ...entry }) => entry) },
    }));
  });

  app.post('/v1/outbox/freeze', async (c) => {
    const input = outboxFreezeInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) return c.json({ error: { code: 'INVALID_BODY', message: 'frozen must be true or false' } }, 400);
    const store = scoped(c);
    if (store === undefined) return unavailable(c);
    const ownerId = getOwnerId(c);
    await store.put('outboxControl', { id: ownerId, ownerId, frozen: input.data.frozen, updatedAt: new Date().toISOString() });
    if (!input.data.frozen) deps.outbox?.wake();
    return c.json(outboxFreezeSchema.parse({ frozen: input.data.frozen }));
  });

  app.post('/v1/outbox/:id/retry', async (c) => {
    const store = scoped(c);
    if (store === undefined) return unavailable(c);
    const row = await store.get('outbox', c.req.param('id'));
    if (row === null) return c.json({ error: { code: 'NOT_FOUND', message: 'No such delivery.' } }, 404);
    if (row.status !== 'dropped') return c.json({ error: { code: 'NOT_DROPPED', message: 'Only a delivery that was given up on can be retried.' } }, 409);
    // Back to pending with fresh tries; the agent is not told again if it drops again (one note per delivery).
    const { droppedReason: _reason, droppedAt: _at, lastError: _error, ...rest } = row;
    const pending: OutboxRow = { ...rest, status: 'pending', attempts: 0, nextAttemptAt: new Date().toISOString() };
    await store.put('outbox', pending);
    await announceDelivery(deps.store, pending).catch(() => undefined);
    deps.outbox?.wake();
    return c.json({ id: row.id });
  });
}
