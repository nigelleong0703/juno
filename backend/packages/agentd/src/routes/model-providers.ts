import { type Hono } from 'hono';
import { getOwnerId } from '../auth.js';
import { listBuiltinProviders } from 'juno-agent/execution/brain/builtin-providers';
import { userProviderCatalog } from 'juno-agent/execution/brain/user-provider-catalog';
import { describeFastModel, readFastModelEnv } from 'juno-agent/execution/brain/fast-model';
import { backendConfigSchema } from 'juno-agent/execution/config';
import { getModelCatalogLoader, readModelEnv } from 'juno-agent/execution/brain/model-catalog';
import { createAccountModelSelection } from 'juno-agent/execution/brain/model-selection';
import { describeSystemOne, readSystemOneEnv, resolveSystemOne } from 'juno-agent/execution/brain/system-one';
import type { AgentdDeps } from './index.js';

/**
 * Model providers an owner can add a key for. The built-in list and catalogs come from the pi-ai
 * registry; a custom endpoint's list is probed with the owner's own key. Owner-scoped: another owner's
 * provider id answers 404, and no response carries a key.
 */
export function registerModelProviders(app: Hono, deps: AgentdDeps) {
  app.get('/v1/model-providers/builtin', (c) => {
    getOwnerId(c);
    return c.json({ items: listBuiltinProviders() });
  });

  // The fast model background calls would use for this owner right now (settings shows it under "Auto").
  // Platform-paid models only apply when configured; null means no model can answer background calls.
  // The same resolver the runs use (model-selection.ts), built from the service config: no agent, so the owner is explicit.
  const selection = () => {
    const raw = deps.config ?? {};
    const config = backendConfigSchema.parse(raw);
    const env = config.MODEL_BASE_URL && config.MODEL_ID ? readModelEnv(config) : undefined;
    const systemEnv = readFastModelEnv(config);
    return createAccountModelSelection({ store: deps.store, config, ...(env === undefined ? {} : { env, catalog: getModelCatalogLoader(env) }), ...(systemEnv === undefined ? {} : { systemEnv }) });
  };
  const effectiveFast = async (ownerId: string) => {
    const config = deps.config ?? {};
    const chosen = describeFastModel(await selection().resolveFast?.(ownerId, 'job'));
    const main = config['MODEL_BASE_URL'] && config['MODEL_ID'] ? String(config['MODEL_ID']) : undefined;
    return chosen ?? (main === undefined ? null : { providerId: null, modelId: main, source: 'agent' as const });
  };
  app.get('/v1/model-providers/fast-model', async (c) => c.json(await effectiveFast(getOwnerId(c))));
  // The four tiers as they resolve now (settings shows each under "Default").
  app.get('/v1/model-providers/tiers', async (c) => c.json(await selection().describeTiers?.(getOwnerId(c)) ?? null));

  // The System One model decisions would use: the owner's choice, the platform's endpoint, else the fast model emulating one.
  app.get('/v1/model-providers/system-one', async (c) => {
    const ownerId = getOwnerId(c);
    const selection = await resolveSystemOne(deps.store, ownerId, readSystemOneEnv(deps.config ?? {}));
    return c.json(describeSystemOne(selection, await effectiveFast(ownerId)));
  });

  app.get('/v1/model-providers/:id/models', async (c) => {
    const ownerId = getOwnerId(c);
    const result = await userProviderCatalog(deps.store, ownerId, c.req.param('id'));
    if (result.kind === 'not-found') return c.json({ error: { code: 'NOT_FOUND', message: 'Model provider not found' } }, 404);
    if (result.kind === 'unavailable') return c.json({ error: { code: 'MODEL_CATALOG_UNAVAILABLE', message: 'Model catalog is unavailable' } }, 503);
    return c.json(result.catalog);
  });
}
