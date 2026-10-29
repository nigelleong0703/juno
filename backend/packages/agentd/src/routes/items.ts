import { type Hono } from 'hono';
import { NotFoundError } from '@agent-desktop/contracts';
import { parseListQuery } from './query-helpers.js';
import type { AgentdDeps } from './index.js';

export function registerItems(app: Hono, deps: AgentdDeps) {
  app.get('/v1/items', async (c) => {
    const query = parseListQuery(Object.fromEntries(Object.entries(c.req.query())));
    const page = await deps.store.list('items', query);
    return c.json({ items: page.items, nextCursor: page.nextCursor });
  });

  app.get('/v1/items/:id', async (c) => {
    const item = await deps.store.get('items', c.req.param('id'));
    if (!item) throw new NotFoundError('items', c.req.param('id'));
    return c.json(item);
  });
}
