/** Owner integrations: plugin metadata and tool permissions. (Connections are apps now: routes/apps.ts.) */
import type { Context, Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { toolPermissionSchema } from '@agent-desktop/public-contracts';
import { createAppRepository } from '../app-repository.js';
import { requestOwner } from '../owner.js';
import { parseListQuery } from './list-query.js';
import type { AppRoutesDeps } from './index.js';

const toolPermissionInputSchema = z.object({
  pluginId: z.string().min(1),
  toolId: z.string().min(1),
  permission: toolPermissionSchema,
});

export function registerPlugins(app: Hono, deps: AppRoutesDeps): void {
  const repo = (c: Context) => createAppRepository(deps.store, deps.blobs, requestOwner(c), deps.settingsUpdater);

  app.get('/v1/plugins', async (c) => {
    const page = await repo(c).integrations.listPlugins(parseListQuery(c.req.query()));
    return c.json({ items: page.items, nextCursor: page.nextCursor ?? null });
  });

  app.get('/v1/plugins/secrets', (c) => {
    // The API stores no secret values, so the metadata list is empty rather than invented.
    return c.json([]);
  });

  app.get('/v1/plugins/:id', async (c) => {
    const plugin = await repo(c).integrations.getPlugin(c.req.param('id'));
    if (!plugin) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'plugins ' + c.req.param('id') + ' not found' } }, 404);
    }
    return c.json(plugin);
  });

  app.post('/v1/plugins/tool-permission', zValidator('json', toolPermissionInputSchema), async (c) => {
    const input = c.req.valid('json');
    const plugin = await repo(c).integrations.setToolPermission(input.pluginId, input.toolId, input.permission);
    return c.json(plugin);
  });

  app.post('/v1/plugins/:id/install', async (c) => {
    return c.json(await repo(c).integrations.setPluginInstalled(c.req.param('id'), true));
  });

  app.post('/v1/plugins/:id/uninstall', async (c) => {
    return c.json(await repo(c).integrations.setPluginInstalled(c.req.param('id'), false));
  });

}
