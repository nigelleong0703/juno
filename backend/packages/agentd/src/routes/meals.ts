import { type Hono } from 'hono';
import { isoDateTimeSchema } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { docOwnerId, listAll, paginateFiltered } from './relationships.js';

/** The food diary the agents keep; the apps read it (and may later write it to Apple Health). Every read stays inside the caller's rows. */
export function registerMeals(app: Hono, deps: AgentdDeps) {
  // from is inclusive, to exclusive; both are instants, so each app turns its own days into a range.
  app.get('/v1/meals', async (c) => {
    const ownerId = getOwnerId(c);
    const query = c.req.query();
    const bound = (name: 'from' | 'to') => (query[name] === undefined ? undefined : isoDateTimeSchema.safeParse(query[name]));
    const from = bound('from');
    const to = bound('to');
    if ((from !== undefined && !from.success) || (to !== undefined && !to.success)) {
      return c.json({ error: { code: 'INVALID_RANGE', message: 'from and to must be ISO date-times' } }, 400);
    }
    const loaded = await listAll(deps.store, 'meals');
    if (loaded.truncated) {
      return c.json({ error: { code: 'LIST_TRUNCATED', message: 'Meal list truncated; retry later' } }, 500);
    }
    const lower = from?.success === true ? Date.parse(from.data) : -Infinity;
    const upper = to?.success === true ? Date.parse(to.data) : Infinity;
    const own = loaded.items
      .filter((row) => docOwnerId(row) === ownerId)
      .filter((row) => Date.parse(row.eatenAt) >= lower && Date.parse(row.eatenAt) < upper)
      .sort((a, b) => b.eatenAt.localeCompare(a.eatenAt) || a.id.localeCompare(b.id));
    const page = paginateFiltered(own, query['limit'], query['cursor']);
    return c.json({ items: page.items, nextCursor: page.nextCursor ?? null });
  });
}
