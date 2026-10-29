/** Owner usage: truthful aggregation over the owner's runs in the trailing week, plus the per-run ledger. */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { createAppRepository } from '../app-repository.js';
import { requestOwner } from '../owner.js';
import { parseListQuery } from './list-query.js';
import type { AppRoutesDeps } from './index.js';

const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const ledgerFilterSchema = z.object({ agentId: z.string().min(1).optional() });

export function registerUsage(app: Hono, deps: AppRoutesDeps): void {
  app.get('/v1/usage', async (c: Context) => {
    const repo = createAppRepository(deps.store, deps.blobs, requestOwner(c), deps.settingsUpdater);
    const start = new Date(Date.now() - USAGE_WINDOW_MS).toISOString();
    return c.json(await repo.activity.getUsage(start));
  });

  app.get('/v1/usage/ledger', async (c: Context) => {
    const repo = createAppRepository(deps.store, deps.blobs, requestOwner(c), deps.settingsUpdater);
    const raw = c.req.query();
    return c.json(await repo.activity.getLedger(parseListQuery(raw), ledgerFilterSchema.parse(raw).agentId));
  });
}
