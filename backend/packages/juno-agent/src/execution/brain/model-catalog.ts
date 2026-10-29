import { type ModelCatalog, type ModelCatalogItem } from '@agent-desktop/public-contracts';
import { fetchModelsDocument } from './model-limits.js';
import { catalogEntrySchema, catalogResponseSchema, measuredEfforts, toCatalogItem } from './model-catalog-fields.js';
import { parseSupportsImages } from '../provider.js';


/**
 * Server-side model endpoint values. The key only ever leaves in the upstream
 * Authorization header; snapshots and catalog responses never carry it.
 */
export interface ModelEnv {
  modelId: string;
  baseUrl: string;
  apiKey: string;
  /** Strict MODEL_SUPPORTS_IMAGES flag; authoritative only for the current default model. */
  supportsImages: boolean;
  /** Optional MODEL_FALLBACK_ID: one same-endpoint model a turn falls back to after transient retries. */
  fallbackModelId?: string;
}

export function readModelEnv(
  config: { MODEL_ID: string; MODEL_BASE_URL: string; MODEL_API_KEY: string },
  env: NodeJS.ProcessEnv = process.env,
): ModelEnv {
  const fallbackModelId = (env['MODEL_FALLBACK_ID'] ?? '').trim();
  return {
    modelId: config.MODEL_ID,
    baseUrl: config.MODEL_BASE_URL,
    apiKey: config.MODEL_API_KEY,
    supportsImages: parseSupportsImages(env['MODEL_SUPPORTS_IMAGES']),
    // A blank MODEL_FALLBACK_ID means no fallback.
    ...(fallbackModelId.length === 0 ? {} : { fallbackModelId }),
  };
}

function defaultItem(env: ModelEnv): ModelCatalogItem {
  // The gateway does not list the default model (OCX lists `gpt-5.6-luna`, not `opencode-go/gpt-5.6-luna`): only the
  // measured table knows its levels. Otherwise they are unknown, so the reasoning field is omitted, not empty.
  const measured = measuredEfforts(env.modelId);
  return {
    id: env.modelId,
    name: env.modelId,
    supportsImages: env.supportsImages,
    ...(measured === undefined ? {} : { reasoningEfforts: measured.efforts, ...(measured.noReasoning ? { noReasoning: true as const } : {}) }),
  };
}

function fallbackCatalog(env: ModelEnv): ModelCatalog {
  return { defaultModel: env.modelId, items: [defaultItem(env)] };
}

export interface LoadedCatalog {
  catalog: ModelCatalog;
  /** False when upstream was unreachable/unparseable and the default-only fallback was used. */
  fresh: boolean;
}

async function loadCatalog(env: ModelEnv, fetchFn: typeof fetch): Promise<LoadedCatalog> {
  const document = await fetchModelsDocument(env.baseUrl, env.apiKey, fetchFn);
  if (document === null) return { catalog: fallbackCatalog(env), fresh: false };
  const parsed = catalogResponseSchema.safeParse(document);
  if (!parsed.success) return { catalog: fallbackCatalog(env), fresh: false };
  const seen = new Set<string>();
  const items: ModelCatalogItem[] = [];
  for (const raw of parsed.data.data) {
    // One malformed entry never sinks the whole document: it is skipped and the rest still load.
    const entry = catalogEntrySchema.safeParse(raw);
    if (!entry.success) continue;
    const item = toCatalogItem(entry.data, env);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  // The current default is always selectable: when a fresh upstream answer omits it the
  // env-described item stands in rather than breaking every run.
  if (!seen.has(env.modelId)) items.push(defaultItem(env));
  return { catalog: { defaultModel: env.modelId, items }, fresh: true };
}

export interface ModelCatalogLoader {
  /** Cached, single-flight catalog load. Never rejects and never carries credentials. */
  load(): Promise<LoadedCatalog>;
}

/** Short TTL: the catalog tracks deploys without a fresh probe on every turn. */
const CATALOG_TTL_MS = 30_000;

export function createModelCatalogLoader(env: ModelEnv, fetchFn: typeof fetch = fetch): ModelCatalogLoader {
  let cached: { result: LoadedCatalog; expiresAt: number } | undefined;
  let inFlight: Promise<LoadedCatalog> | undefined;
  return {
    load(): Promise<LoadedCatalog> {
      if (cached !== undefined && Date.now() < cached.expiresAt) return Promise.resolve(cached.result);
      if (inFlight === undefined) {
        inFlight = loadCatalog(env, fetchFn)
          .then((result) => {
            cached = { result, expiresAt: Date.now() + CATALOG_TTL_MS };
            return result;
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      return inFlight;
    },
  };
}

const sharedLoaders = new Map<string, ModelCatalogLoader>();

/** Process-wide loader per endpoint+default so HTTP requests share the probe cache. */
export function getModelCatalogLoader(env: ModelEnv, fetchFn: typeof fetch = fetch): ModelCatalogLoader {
  const key = env.baseUrl + '\0' + env.modelId + '\0' + String(env.supportsImages);
  const existing = sharedLoaders.get(key);
  if (existing) return existing;
  const loader = createModelCatalogLoader(env, fetchFn);
  sharedLoaders.set(key, loader);
  return loader;
}
