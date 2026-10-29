import { type Context, type Hono } from 'hono';
import { isoDateTimeSchema, updateAgentCalendarItemSchema, type AgentCalendarItem } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { docOwnerId, listAll } from './relationships.js';

/**
 * The agent's own calendar (BACKEND "Agent 自己的日历"). Agents create items with their calendar_* tools; the owner reads them here,
 * may retitle, move or rewrite one, and may cancel it (DELETE = cancel; the row stays as `cancelled`). Every route stays inside the
 * caller's rows, and a change re-arms the item's timer.
 */
export function registerCalendar(app: Hono, deps: AgentdDeps) {
  const range = async (c: Context, agentId?: string) => {
    const ownerId = getOwnerId(c);
    const query = c.req.query();
    const bound = (name: 'from' | 'to') => (query[name] === undefined ? undefined : isoDateTimeSchema.safeParse(query[name]));
    const from = bound('from');
    const to = bound('to');
    if ((from !== undefined && !from.success) || (to !== undefined && !to.success)) {
      return c.json({ error: { code: 'INVALID_RANGE', message: 'from and to must be ISO date-times' } }, 400);
    }
    const loaded = await listAll(deps.store, 'agentCalendar');
    if (loaded.truncated) return c.json({ error: { code: 'LIST_TRUNCATED', message: 'Calendar list truncated; retry later' } }, 500);
    const lower = from?.success === true ? Date.parse(from.data) : -Infinity;
    const upper = to?.success === true ? Date.parse(to.data) : Infinity;
    const items = loaded.items
      .filter((row) => docOwnerId(row) === ownerId && (agentId === undefined || row.agentId === agentId))
      .filter((row) => Date.parse(row.at) >= lower && Date.parse(row.at) < upper)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    return c.json({ items });
  };

  app.get('/v1/calendar', (c) => range(c));

  app.get('/v1/agents/:id/calendar', async (c) => {
    const agentId = c.req.param('id');
    const agent = await deps.store.get('agents', agentId);
    if (agent === null || docOwnerId(agent) !== getOwnerId(c)) return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404);
    return range(c, agentId);
  });

  const own = async (c: Context): Promise<AgentCalendarItem | undefined> => {
    const row = await deps.store.get('agentCalendar', c.req.param('id') ?? '');
    return row !== null && docOwnerId(row) === getOwnerId(c) ? row : undefined;
  };
  const notFound = (c: Context) => c.json({ error: { code: 'CALENDAR_ITEM_NOT_FOUND', message: 'Calendar item not found' } }, 404);

  app.patch('/v1/calendar/:id', async (c) => {
    const row = await own(c);
    if (row === undefined) return notFound(c);
    const parsed = updateAgentCalendarItemSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ') } }, 400);
    const input = parsed.data;
    if (row.status !== 'scheduled') return c.json({ error: { code: 'CALENDAR_ITEM_CLOSED', message: `The item is ${row.status}` } }, 409);
    if (input.at !== undefined && Date.parse(input.at) <= Date.now()) return c.json({ error: { code: 'INVALID_TIME', message: 'at must be in the future' } }, 400);
    const updated = await deps.store.patch('agentCalendar', row.id, { ...input, updatedAt: new Date().toISOString() });
    if (input.at !== undefined || input.status !== undefined) await deps.enqueuer.scheduleCalendarItem?.(row.id);
    return c.json(updated);
  });

  app.delete('/v1/calendar/:id', async (c) => {
    const row = await own(c);
    if (row === undefined) return notFound(c);
    if (row.status !== 'scheduled') return c.json(row);
    const updated = await deps.store.patch('agentCalendar', row.id, { status: 'cancelled', updatedAt: new Date().toISOString() });
    await deps.enqueuer.scheduleCalendarItem?.(row.id);
    return c.json(updated);
  });
}
