/** Owner settings: durable read and merged partial update (never forwarded to agentd). */
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { updateSettingsInputSchema } from '@agent-desktop/public-contracts';
import type { AppSettings, AppSettingsResponse, UpdateSettingsInput } from '@agent-desktop/public-contracts';
import { createAppRepository } from '../app-repository.js';
import { ModelCatalogUnavailableError, UnknownModelError, UnknownProviderError, UnsupportedEffortError } from '../modules/settings.js';
import { requestOwner } from '../owner.js';
import type { AppRoutesDeps } from './index.js';

/** The settings plus the tiers and the System One model as they resolve now (null when unknown; never fails the read). */
async function withEffectiveModels(deps: AppRoutesDeps, ownerId: string, settings: AppSettings): Promise<AppSettingsResponse> {
  const client = deps.providerClient;
  const [effectiveTiers, effectiveSystemOneModel] = client === undefined
    ? [null, null]
    : await Promise.all([client.effectiveTiers(ownerId).catch(() => null), client.effectiveSystemOneModel(ownerId).catch(() => null)]);
  return { ...settings, effectiveTiers, effectiveSystemOneModel };
}

export function registerSettings(app: Hono, deps: AppRoutesDeps): void {
  app.get('/v1/settings', async (c) => {
    const repo = createAppRepository(deps.store, deps.blobs, requestOwner(c), deps.settingsUpdater, deps.modelsLoader, deps.providerClient);
    return c.json(await withEffectiveModels(deps, requestOwner(c), await repo.settings.get()));
  });

  app.patch(
    '/v1/settings',
    zValidator('json', updateSettingsInputSchema.optional()),
    async (c) => {
      const repo = createAppRepository(deps.store, deps.blobs, requestOwner(c), deps.settingsUpdater, deps.modelsLoader, deps.providerClient);
      const patch: UpdateSettingsInput = c.req.valid('json') ?? {};
      try {
        const saved = await repo.settings.update(patch);
        // The owner chose their model: a new account's first greeting, which could not run without one, runs now.
        const chosen = saved.models?.providerId;
        if (patch.models !== undefined && chosen && saved.models?.defaultModel) await deps.providerClient?.modelChosen?.(requestOwner(c), chosen);
        return c.json(await withEffectiveModels(deps, requestOwner(c), saved));
      } catch (error) {
        if (error instanceof UnknownModelError) {
          return c.json({ error: { code: 'UNKNOWN_MODEL', message: 'Unknown model' } }, 400);
        }
        if (error instanceof UnknownProviderError) {
          return c.json({ error: { code: 'UNKNOWN_PROVIDER', message: 'Unknown model provider' } }, 400);
        }
        if (error instanceof UnsupportedEffortError) {
          return c.json({ error: { code: 'UNSUPPORTED_EFFORT', message: error.message } }, 400);
        }
        if (error instanceof ModelCatalogUnavailableError) {
          return c.json({ error: { code: 'MODEL_CATALOG_UNAVAILABLE', message: 'Model catalog is unavailable' } }, 503);
        }
        throw error;
      }
    },
  );
}
