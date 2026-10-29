/**
 * Settings module: the owner's app-wide configuration, stored as one row per owner.
 *
 * Reads merge the stored row over the fresh-install defaults. Updates merge the validated
 * patch over both so a section patch never resets its siblings. The write itself is the
 * caller's choice: production injects an advisory-locked Postgres updater (settings-postgres.ts)
 * for multi-process safety, while the in-process path here is for the memory store and tests.
 * A non-null account model choice is validated server-side against the agentd model catalog
 * (known item ids only) before any write; a null reset and model-less patches skip the
 * catalog entirely so they work offline.
 */
import type { Store } from '@agent-desktop/contracts';
import type { AppSettings, ModelCatalog, UpdateSettingsInput } from '@agent-desktop/public-contracts';
import type { ModelProviderCatalogClient } from './model-providers.js';
import { appSettingsSchema, modelCatalogSchema } from '@agent-desktop/public-contracts';

/** Fresh-install settings; a stored row always wins over these. */
export const DEFAULT_SETTINGS: AppSettings = {
  general: { launchAtLogin: false, language: 'en' },
  appearance: { theme: 'system', density: 'comfortable', accent: '#0066cc' },
  notifications: [],
  yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
  connections: { serverUrl: 'http://localhost:8787', modelProviders: [] },
  privacy: { dataRetentionDays: 90, trainingOptIn: false },
  advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
  models: { defaultModel: null },
};

/** Per-owner settings row id: ids are global keys, so the owner is part of the id. */
export function settingsIdFor(ownerId: string): string {
  return 'app-settings-' + ownerId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursive object merge: stored values survive unless the patch states them (arrays replace). */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = deepMerge(merged[key], value);
  }
  return merged;
}

/**
 * Defaults -> stored row -> validated patch, re-validated as a whole contract settings object.
 * The `usage` budget is a whole object, not a deep merge: a saved budget replaces the stored one, so
 * clearing a field actually removes that constraint instead of leaving the previous value in place.
 */
export function mergeSettings(current: unknown, patch: UpdateSettingsInput): AppSettings {
  const base = deepMerge(deepMerge(DEFAULT_SETTINGS, current ?? {}), patch);
  const merged = isRecord(base) ? base : {};
  if (patch.usage !== undefined) merged.usage = patch.usage;
  // Tiers replace whole too (like `usage`): clearing a row, or its effort, must really remove it.
  const tiers = patch.models?.tiers;
  if (tiers !== undefined && isRecord(merged.models)) merged.models.tiers = tiers;
  return appSettingsSchema.parse(merged);
}

/** Durable settings writer; production uses the advisory-locked Postgres implementation. */
export type SettingsUpdater = (ownerId: string, patch: UpdateSettingsInput) => Promise<AppSettings>;

/** Loads the authoritative model catalog for one owner (agentd owns the catalog). */
export type ModelCatalogLoader = (ownerId: string) => Promise<ModelCatalog>;

/** Non-null model choice is not in the catalog's known ids. Mapped to 400 upstream. */
export class UnknownModelError extends Error {
  readonly modelId: string;
  constructor(modelId: string) {
    super('Unknown model: ' + modelId);
    this.name = 'UnknownModelError';
    this.modelId = modelId;
  }
}

/** Catalog could not be loaded or parsed, so the write is refused. Mapped to 503. */
export class ModelCatalogUnavailableError extends Error {
  constructor() {
    super('Model catalog is unavailable');
    this.name = 'ModelCatalogUnavailableError';
  }
}

export interface AgentdCatalogDeps {
  agentdUrl: string;
  internalToken: string;
  fetchFn: typeof fetch;
  /** Bound for the catalog fetch; defaults to MODEL_CATALOG_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Bound for the server-side catalog fetch. Above the ~3s agentd probe so a slow
 * catalog still answers, but a hung agentd aborts instead of hanging the save.
 */
export const MODEL_CATALOG_TIMEOUT_MS = 5000;

/**
 * Server-side catalog fetch: speaks as the gateway itself (service bearer plus the
 * authoritative owner, mirroring proxy.ts) and parses with the public schema. Any
 * transport, status or shape failure becomes a generic unavailable error so upstream
 * bodies, statuses and credentials never leak to the client.
 */
export function createAgentdModelCatalogLoader(deps: AgentdCatalogDeps): ModelCatalogLoader {
  return async (ownerId: string): Promise<ModelCatalog> => {
    const target = deps.agentdUrl.replace(/\/$/, '') + '/v1/models';
    let response: Response;
    try {
      response = await deps.fetchFn(target, {
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + deps.internalToken,
          'x-owner-id': ownerId,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(deps.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS),
      });
    } catch {
      throw new ModelCatalogUnavailableError();
    }
    if (!response.ok) throw new ModelCatalogUnavailableError();
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ModelCatalogUnavailableError();
    }
    const parsed = modelCatalogSchema.safeParse(body);
    if (!parsed.success) throw new ModelCatalogUnavailableError();
    return parsed.data;
  };
}

/** A chosen provider id the owner does not have (or that is another owner's). Mapped to 400 upstream. */
export class UnknownProviderError extends Error {
  constructor(readonly providerId: string) {
    super('Unknown model provider');
    this.name = 'UnknownProviderError';
  }
}

/** A tier effort the row's model does not offer. Mapped to 400 upstream. */
export class UnsupportedEffortError extends Error {
  constructor(tier: string, effort: string, modelId: string) {
    super('The ' + tier + ' tier cannot use effort "' + effort + '": model "' + modelId + '" does not offer it');
    this.name = 'UnsupportedEffortError';
  }
}

/** The catalog a model choice belongs to: the owner's provider, or the platform default when there is none. */
async function catalogOf(ownerId: string, providerId: string | null | undefined, loader: ModelCatalogLoader | undefined, providers: ModelProviderCatalogClient | undefined): Promise<ModelCatalog> {
  if (typeof providerId === 'string') {
    if (!providers) throw new ModelCatalogUnavailableError();
    const result = await providers.providerModels(ownerId, providerId);
    if (result.kind === 'not-found') throw new UnknownProviderError(providerId);
    if (result.kind === 'unavailable') throw new ModelCatalogUnavailableError();
    return result.catalog;
  }
  if (!loader) throw new ModelCatalogUnavailableError();
  try {
    return await loader(ownerId);
  } catch {
    throw new ModelCatalogUnavailableError();
  }
}

/**
 * The tiers the owner ends up with are checked whenever the tiers or the main model change: a row's model must be in its
 * catalog and its effort one that model offers (an effort-only row uses the main model; `fast` always names its model).
 */
async function ensureKnownTiers(
  ownerId: string,
  patch: UpdateSettingsInput,
  loader: ModelCatalogLoader | undefined,
  providers: ModelProviderCatalogClient | undefined,
  stored: AppSettings['models'] | undefined,
): Promise<void> {
  const models = patch.models;
  const mainChanged = models?.providerId !== undefined || models?.defaultModel !== undefined;
  if (models?.tiers === undefined && !mainChanged) return;
  const tiers = models?.tiers !== undefined ? models.tiers : stored?.tiers;
  if (tiers === null || tiers === undefined) return;
  const mainProvider = models?.providerId !== undefined ? models.providerId : stored?.providerId ?? null;
  const mainModel = models?.defaultModel !== undefined ? models.defaultModel : stored?.defaultModel ?? null;
  for (const [name, row] of Object.entries(tiers)) {
    if (row.modelId === undefined && row.effort === undefined) continue;
    const providerId = row.modelId === undefined ? mainProvider : row.providerId;
    const catalog = await catalogOf(ownerId, providerId, loader, providers);
    const modelId = row.modelId ?? mainModel ?? catalog.defaultModel;
    const item = catalog.items.find((entry) => entry.id === modelId);
    if (item === undefined) throw new UnknownModelError(modelId);
    if (row.effort !== undefined && item.reasoningEfforts?.includes(row.effort) !== true) throw new UnsupportedEffortError(name, row.effort, modelId);
  }
}

/**
 * A non-null model choice is checked against the catalog it belongs to: the owner's provider when one is
 * chosen (its own catalog, the owner's key), otherwise the platform default catalog.
 */
async function ensureKnownModel(
  scoped: Store,
  ownerId: string,
  patch: UpdateSettingsInput,
  loader: ModelCatalogLoader | undefined,
  providers: ModelProviderCatalogClient | undefined,
  stored: AppSettings['models'] | undefined,
): Promise<void> {
  const models = patch.models;
  if (models === undefined) return;
  // A System One provider is not a chat provider: it can be neither the agent model's nor a tier's.
  for (const chat of [...Object.values(models.tiers ?? {}).map((row) => row.providerId), models.providerId]) {
    if (typeof chat === 'string' && (await scoped.get('modelProviders', chat))?.kind === 'systemone') throw new UnknownProviderError(chat);
  }
  const pick = models.systemOneModel;
  if (pick !== undefined && pick !== null) {
    const record = await scoped.get('modelProviders', pick.providerId);
    if (record === null || record.ownerId !== ownerId || record.kind !== 'systemone') throw new UnknownProviderError(pick.providerId);
    if (record.models?.includes(pick.modelId) !== true) throw new UnknownModelError(pick.modelId);
  }
  await ensureKnownTiers(ownerId, patch, loader, providers, stored);
  const providerChoice = models.providerId !== undefined ? models.providerId : stored?.providerId ?? null;
  if (providerChoice !== null) {
    if (models.providerId === undefined && models.defaultModel === undefined) return;
    const wanted = models.defaultModel !== undefined ? models.defaultModel : stored?.defaultModel ?? null;
    if (!providers) throw new ModelCatalogUnavailableError();
    const result = await providers.providerModels(ownerId, providerChoice);
    if (result.kind === 'not-found') throw new UnknownProviderError(providerChoice);
    if (result.kind === 'unavailable') throw new ModelCatalogUnavailableError();
    if (wanted !== null && !result.catalog.items.some((item) => item.id === wanted)) throw new UnknownModelError(wanted);
    return;
  }
  const wanted = models.defaultModel;
  if (wanted === undefined || wanted === null) return;
  if (!loader) throw new ModelCatalogUnavailableError();
  let catalog: ModelCatalog;
  try {
    catalog = await loader(ownerId);
  } catch (error) {
    if (error instanceof UnknownModelError) throw error;
    throw new ModelCatalogUnavailableError();
  }
  const known = catalog.items.some((item) => item.id === wanted);
  if (!known) throw new UnknownModelError(wanted);
}

export interface SettingsModule {
  get(): Promise<AppSettings>;
  update(patch: UpdateSettingsInput): Promise<AppSettings>;
}

export function createSettingsModule(
  scoped: Store,
  ownerId: string,
  updater?: SettingsUpdater,
  modelsLoader?: ModelCatalogLoader,
  providers?: ModelProviderCatalogClient,
): SettingsModule {
  const id = settingsIdFor(ownerId);
  return {
    async get(): Promise<AppSettings> {
      const stored = await scoped.get('settings', id);
      return appSettingsSchema.parse(deepMerge(DEFAULT_SETTINGS, stored ?? {}));
    },

    async update(patch: UpdateSettingsInput): Promise<AppSettings> {
      const stored = await scoped.get('settings', id);
      await ensureKnownModel(scoped, ownerId, patch, modelsLoader, providers, stored?.models);
      if (updater) return updater(ownerId, patch);
      return scoped.tx(async (tx) => {
        const merged = mergeSettings(await tx.get('settings', id), patch);
        await tx.put('settings', { id, ...merged });
        return merged;
      });
    },
  };
}
