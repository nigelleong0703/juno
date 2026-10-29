import { type Hono } from 'hono';
import { z } from 'zod';
import { getOwnerId } from '../auth.js';
import { getModelCatalogLoader, readModelEnv } from 'juno-agent/execution/brain/model-catalog';
import type { AgentdDeps } from './index.js';

/** Model endpoint values the route reads off the service config; validated, never echoed. The platform default is optional. */
const modelEnvSchema = z.object({
  MODEL_ID: z.string().min(1),
  MODEL_BASE_URL: z.string().min(1),
  MODEL_API_KEY: z.string(),
});

/**
 * Account model catalog. Authenticated like every other /v1 route (service bearer plus
 * owner on the internal app). The response carries only ids, names and vision flags:
 * credentials and upstream error bodies never leave the process. When upstream is
 * unreachable the route reports 503 so the caller can retry, while the run-time
 * selection keeps the env-default fallback for continuity.
 */
export function registerModels(app: Hono, deps: AgentdDeps) {
  app.get('/v1/models', async (c) => {
    getOwnerId(c);
    const parsed = modelEnvSchema.safeParse(deps.config ?? {});
    // No platform default: the owner's own providers answer their catalogs (/v1/model-providers/:id/models).
    if (!parsed.success) return c.json({ error: { code: 'MODEL_NOT_CONFIGURED', message: 'No platform model is configured' } }, 404);
    const loader = getModelCatalogLoader(readModelEnv(parsed.data));
    const loaded = await loader.load();
    // Honest outage signal: a stale default-only answer would hide a provider outage and
    // block the UI from erroring and retrying. Explicit writes fail closed upstream; the
    // run-time fallback for the env default lives in the selection, not in this response.
    if (!loaded.fresh) {
      return c.json({ error: { code: 'MODEL_CATALOG_UNAVAILABLE', message: 'Model catalog is unavailable' } }, 503);
    }
    return c.json(loaded.catalog);
  });
}
