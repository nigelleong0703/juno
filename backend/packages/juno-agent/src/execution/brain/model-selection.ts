import { z } from 'zod';
import type { BrainContext, Store } from '../../contracts/index.js';
import { modelWireSchema, reasoningEffortSchema, settingsIdFor, type EffectiveTier, type EffectiveTiers, type ReasoningEffort, type TierName } from '@agent-desktop/public-contracts';
import type { BackendConfig } from '../config.js';
import { currentOwnerId } from '../../owner-context.js';
import { docOwner } from '../execution-owner.js';
import type { ModelEnv, ModelCatalogLoader, LoadedCatalog } from './model-catalog.js';
import type { LimitsAwareProvider } from './model-limits.js';
import { createOpenAIProvider, type OpenAIProviderOptions } from './provider.js';
import { freezeRuntimeControls, readStoredModelSettings, type ModelRuntimeControls } from './model-runtime-settings.js';
import { ModelSelectionError, toTerminalModelError } from './model-selection-error.js';
import { modelPricingSchema, pricedSnapshotExtension, snapshotPricingFragment } from './model-pricing.js';
import type { FrozenRuntimeControls, StoredModelSettings } from './model-runtime-settings.js';
import { createUserProvider, readOwnedProvider, type UserProviderBinding } from './user-providers.js';
import { frozenOrThrow, ownerProviderSnapshot } from './owner-snapshot.js';
import { resolveFastModel, type FastModelSelection } from './fast-model.js';
import type { ChatGPTRefresh } from './chatgpt-credential.js';
import { endpointHasNativeSearch, useNativeWebSearch } from './native-web-search.js';
import { resolveToolSearchMode } from './tool-search-mode.js';
import { tierForLane, tierNameOf, type EffortLane, type EffortTier } from './reasoning-tier.js';

export { ModelSelectionError, toTerminalModelError };
export type { ModelSelectionErrorCode } from './model-selection-error.js';
export { settingsIdFor };

/**
 * Frozen account model choice journaled on the run context. Base URL only: the endpoint a
 * run was resolved against. Credentials never appear here or anywhere downstream.
 *
 * `providerId` names an owner's own provider document; its key is read per call, never stored here.
 * Absent means the platform default endpoint (MODEL_*), which keeps its fallback model and pricing.
 */
export const modelSnapshotSchema = z.object({
  modelId: z.string().min(1),
  baseUrl: z.string(),
  supportsImages: z.boolean(),
  /** Frozen account runtime controls; absent on snapshots written before the controls existed. */
  controls: z
    .object({
      reasoningEffort: reasoningEffortSchema.optional(),
      omitReasoning: z.literal(true).optional(),
      temperature: z.number().optional(),
      maxOutputTokens: z.number().optional(),
    })
    .optional(),
  /** The same-endpoint model a turn falls back to after transient retries; platform default only. */
  fallback: z.object({ modelId: z.string().min(1), pricing: modelPricingSchema.optional() }).optional(),
  /** The owner's provider document this run is bound to; absent for the platform default. */
  providerId: z.string().min(1).optional(),
  /** Wire protocol of a bound provider model. */
  wire: modelWireSchema.optional(),
  /** Context and output limits frozen for a built-in provider model (compaction depends on them). */
  limits: z.object({ contextWindow: z.number().optional(), maxOutputTokens: z.number().optional() }).optional(),
  /**
   * The provider's own web search is offered to this run instead of Juno's web_search. Decided once when the run starts
   * (model capability and the owner's webSearch setting) so the tool list never changes mid-conversation.
   */
  nativeWebSearch: z.literal(true).optional(),
  /**
   * The model reaches hidden tools through the provider's own tool search instead of the `tool_call` proxy (see
   * tool-search-mode.ts). Decided once per run from the model, so the tools array and the system prompt stay stable.
   */
  toolSearch: z.literal('responses-tool-search').optional(),
}).and(pricedSnapshotExtension);
export type ModelSnapshot = z.infer<typeof modelSnapshotSchema>;

/** Read a journaled snapshot; legacy contexts carry none and fall back to the bootstrap provider. */
export function parseModelSnapshot(ctx: BrainContext): ModelSnapshot | undefined {
  const raw = ctx['modelSelection'];
  // Only a missing snapshot is a legacy context. A present but malformed snapshot is journal
  // corruption, not a legacy run: fail loudly instead of silently switching models mid-run.
  if (raw === undefined) return undefined;
  const parsed = modelSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ModelSelectionError('invalid-snapshot', 'Stored model snapshot is invalid; refusing to continue on an unknown model');
  }
  return parsed.data;
}

export interface ModelSelection {
  /**
   * Resolve the account choice once per new run: the owner's provider, or the platform default. The lane picks the
   * reasoning tier the snapshot freezes (reasoning-tier.ts) and the owner's tier row (model, effort) it reads.
   */
  resolve(agentId: string, lane?: EffortLane): Promise<ModelSnapshot>;
  /** The current owner's chosen provider for auxiliary text; undefined when none is chosen. */
  resolveOwnerDefault?(): Promise<ModelSnapshot | undefined>;
  /** The fast model for background calls of one owner (BACKEND §10.14); undefined when none applies. */
  resolveFast?(ownerId: string | undefined, lane?: EffortLane): Promise<FastModelSelection | undefined>;
  /** What each tier runs on for one owner right now (settings shows it as "Default - model, effort"). A tier no model can run is null. */
  describeTiers?(ownerId: string): Promise<EffectiveTiers>;
  /** Provider bound to a frozen snapshot; throws ModelSelectionError on endpoint drift. */
  providerFor(snapshot: ModelSnapshot): LimitsAwareProvider;
}

/** Raised when an owner has no usable provider: none of their own chosen and no platform default configured. */
export function modelProviderRequired(): ModelSelectionError {
  return new ModelSelectionError(
    'MODEL_PROVIDER_REQUIRED',
    'No model provider is configured. Add a model provider with your API key in Settings > Models.',
  );
}

/** Snapshot for the platform default endpoint. */
function snapshotFor(env: ModelEnv, modelId: string, supportsImages: boolean, controls: FrozenRuntimeControls): ModelSnapshot {
  const frozen = Object.keys(controls).length > 0;
  return frozen ? { modelId, baseUrl: env.baseUrl, supportsImages, controls } : { modelId, baseUrl: env.baseUrl, supportsImages };
}

/** The frozen fallback for a primary model: same endpoint, its own exact pricing, no primary controls. */
function fallbackFor(config: BackendConfig, env: ModelEnv, modelId: string): { fallback?: { modelId: string; pricing?: ModelSnapshot['pricing'] } } {
  const fallbackId = env.fallbackModelId;
  if (fallbackId === undefined || fallbackId === modelId) return {};
  const pricing = snapshotPricingFragment(config.MODEL_PRICING_JSON, env.baseUrl, fallbackId);
  return { fallback: { modelId: fallbackId, ...pricing } };
}

/**
 * The context after a turn falls back: the journaled snapshot switches to the fallback model (its
 * own pricing, the primary's endpoint and image support, no primary controls). Undefined when the
 * snapshot names no fallback, so the caller keeps the primary and the failure stays terminal.
 * A provider-bound snapshot never has a fallback: a user's own key is never swapped for another model.
 */
export function withFallbackModel(ctx: BrainContext): BrainContext | undefined {
  const snapshot = parseModelSnapshot(ctx);
  const fallback = snapshot?.fallback;
  if (snapshot === undefined || fallback === undefined) return undefined;
  const next: ModelSnapshot = {
    modelId: fallback.modelId,
    baseUrl: snapshot.baseUrl,
    supportsImages: snapshot.supportsImages,
    ...(fallback.pricing === undefined ? {} : { pricing: fallback.pricing }),
  };
  return { ...ctx, modelSelection: next };
}

export interface AccountModelSelectionDeps {
  store: Store;
  config: BackendConfig;
  /** The platform default endpoint; absent when MODEL_* is not configured. */
  env?: ModelEnv;
  /** The platform's own fast model (FAST_MODEL_*); absent when not configured. */
  systemEnv?: ModelEnv;
  catalog?: ModelCatalogLoader;
  /** Injected in tests so no real provider is built; production uses the OpenAI-compatible one. */
  createProvider?: (snapshot: ModelSnapshot) => LimitsAwareProvider;
  /** ChatGPT token refresh; absent uses pi-ai's own. Injected in tests. */
  chatGPTRefresh?: ChatGPTRefresh;
}

/**
 * Read the stored account model section for one owner. Only the models section is parsed, so
 * unrelated legacy settings fields never gate model choice; a present but malformed section is a
 * misconfiguration that fails explicitly instead of silently bootstrapping a model nobody chose.
 */
async function readAccountSettings(store: Store, ownerId: string): Promise<ModelRuntimeControls | undefined> {
  const stored: StoredModelSettings = readStoredModelSettings(await store.get('settings', settingsIdFor(ownerId)));
  if (stored.kind === 'invalid') {
    throw new ModelSelectionError('invalid-model', 'Stored model settings are invalid; refusing to run on an unknown model');
  }
  return stored.kind === 'controls' ? stored.controls : undefined;
}

/** Provider options a bound snapshot runs with: frozen controls, vision support and pricing. */
function providerOptionsOf(snapshot: ModelSnapshot): OpenAIProviderOptions {
  return {
    supportsImages: snapshot.supportsImages,
    ...(snapshot.controls ?? {}),
    ...(snapshot.pricing === undefined ? {} : { pricing: snapshot.pricing }),
    ...(snapshot.nativeWebSearch === true ? { nativeWebSearch: true } : {}),
    ...(snapshot.toolSearch === undefined ? {} : { toolSearch: snapshot.toolSearch }),
  };
}

/** The frozen binding of a provider snapshot. It carries no key and no owner. */
function bindingOf(snapshot: ModelSnapshot, providerId: string): UserProviderBinding {
  return {
    providerId,
    modelId: snapshot.modelId,
    baseUrl: snapshot.baseUrl,
    wire: snapshot.wire ?? 'openai-completions',
    supportsImages: snapshot.supportsImages,
    ...(snapshot.controls?.reasoningEffort === undefined ? {} : { reasoningEffort: snapshot.controls.reasoningEffort }),
    ...(snapshot.controls?.omitReasoning === true ? { omitReasoning: true as const } : {}),
    ...(snapshot.limits === undefined ? {} : { limits: snapshot.limits }),
  };
}

/** Provider bound to a resolved platform-default snapshot, cached so limits probes are shared across steps. */
function defaultProviderFor(config: BackendConfig, cache: Map<string, LimitsAwareProvider>, snapshot: ModelSnapshot, env: ModelEnv): LimitsAwareProvider {
  if (snapshot.baseUrl !== env.baseUrl) {
    throw new ModelSelectionError(
      'endpoint-changed',
      'Model endpoint changed since this run started; refusing to redirect silently',
    );
  }
  const key = snapshot.baseUrl + '\0' + snapshot.modelId + '\0' + String(snapshot.supportsImages) + '\0' + JSON.stringify(snapshot.controls ?? {}) + '\0' + JSON.stringify(snapshot.pricing ?? null) + '\0' + String(snapshot.nativeWebSearch === true) + '\0' + String(snapshot.toolSearch);
  const existing = cache.get(key);
  if (existing) return existing;
  const created = createOpenAIProvider({ ...config, MODEL_ID: snapshot.modelId, MODEL_BASE_URL: snapshot.baseUrl, MODEL_API_KEY: env.apiKey }, providerOptionsOf(snapshot));
  cache.set(key, created);
  return created;
}

/** The env default needs no catalog unless a reasoning control has to be qualified against it. */
async function loadForSelection(
  catalog: ModelCatalogLoader | undefined,
  wanted: string | null,
  wantsReasoning: boolean,
): Promise<LoadedCatalog | undefined> {
  return catalog !== undefined && (wanted !== null || wantsReasoning) ? catalog.load() : undefined;
}

/**
 * Account-wide model choice. Resolution happens once per new run; every later step,
 * compaction and steering refresh reuses the journaled snapshot, so all agents of one
 * owner inherit a new default on their next run while in-flight runs stay frozen.
 */
export function createAccountModelSelection(deps: AccountModelSelectionDeps): ModelSelection {
  const { store, config, env, catalog, systemEnv } = deps;
  const providerCache = new Map<string, LimitsAwareProvider>();
  const tierOf = (lane: EffortLane): EffortTier => tierForLane(lane, config.CHAT_EFFORT_TIER);

  return {
    async resolve(agentId: string, lane: EffortLane = 'chat'): Promise<ModelSnapshot> {
      const agent = await store.get('agents', agentId);
      const ownerId = (agent ? docOwner(agent) : undefined) ?? currentOwnerId();
      // No owner signal (legacy test fixtures): only the platform default can run.
      if (!ownerId) {
        if (env === undefined) throw modelProviderRequired();
        return { ...snapshotFor(env, env.modelId, env.supportsImages, {}), ...snapshotPricingFragment(config.MODEL_PRICING_JSON, env.baseUrl, env.modelId), ...fallbackFor(config, env, env.modelId) };
      }
      return resolveForOwner(ownerId, lane);
    },
    async describeTiers(ownerId: string): Promise<EffectiveTiers> {
      const controls = await readAccountSettings(store, ownerId).catch(() => undefined);
      const responses = config.MODEL_WIRE_API === 'responses';
      const describe = async (name: TierName, run: () => Promise<ModelSnapshot | undefined>): Promise<EffectiveTier | null> => {
        const snapshot = await run().catch(() => undefined);
        if (snapshot === undefined) return null;
        const row = controls?.tiers?.[name];
        // A Responses run that sends no level sends `none`; a model with no described levels on another wire sends nothing.
        const wireResponses = snapshot.wire === undefined ? responses : snapshot.wire === 'openai-responses';
        const effort = snapshot.controls?.reasoningEffort ?? (wireResponses ? 'none' as const : null);
        return { providerId: snapshot.providerId ?? null, modelId: snapshot.modelId, effort, source: row?.modelId !== undefined || row?.effort !== undefined ? 'chosen' : 'default' };
      };
      const main = (lane: EffortLane) => () => resolveForOwner(ownerId, lane);
      return {
        chat: await describe('chat', main('chat')),
        task: await describe('task', main('job')),
        deep: await describe('deep', main('deep-child')),
        fast: await describe('fast', async () => (await resolveFastFor(ownerId, 'job'))?.snapshot ?? main('job')()),
      };
    },
    async resolveOwnerDefault(): Promise<ModelSnapshot | undefined> {
      const ownerId = currentOwnerId();
      if (ownerId === undefined) return undefined;
      const controls = await readAccountSettings(store, ownerId);
      if (!controls?.providerId) return undefined;
      return ownerProviderSnapshot(store, ownerId, { ...controls, providerId: controls.providerId }, tierOf('job'));
    },
    async resolveFast(ownerId: string | undefined, lane: EffortLane = 'job'): Promise<FastModelSelection | undefined> {
      return resolveFastFor(ownerId, lane);
    },
    providerFor(snapshot: ModelSnapshot): LimitsAwareProvider {
      if (snapshot.providerId !== undefined) {
        const key = JSON.stringify(snapshot);
        const existing = providerCache.get(key);
        if (existing) return existing;
        const created = createUserProvider({ store, binding: bindingOf(snapshot, snapshot.providerId), ownerId: currentOwnerId, ...(deps.chatGPTRefresh ? { refresh: deps.chatGPTRefresh } : {}) }, providerOptionsOf(snapshot));
        providerCache.set(key, created);
        return created;
      }
      if (systemEnv !== undefined && snapshot.baseUrl === systemEnv.baseUrl && snapshot.modelId === systemEnv.modelId) {
        return deps.createProvider ? deps.createProvider(snapshot) : defaultProviderFor(config, providerCache, snapshot, systemEnv);
      }
      if (env === undefined) throw modelProviderRequired();
      if (snapshot.baseUrl !== env.baseUrl) {
        throw new ModelSelectionError('endpoint-changed', 'Model endpoint changed since this run started; refusing to redirect silently');
      }
      if (deps.createProvider) return deps.createProvider(snapshot);
      return defaultProviderFor(config, providerCache, snapshot, env);
    },
  };

  async function resolveFastFor(ownerId: string | undefined, lane: EffortLane): Promise<FastModelSelection | undefined> {
    const platform = systemEnv === undefined ? undefined : { ...snapshotFor(systemEnv, systemEnv.modelId, systemEnv.supportsImages, {}), ...snapshotPricingFragment(config.MODEL_PRICING_JSON, systemEnv.baseUrl, systemEnv.modelId) };
    if (ownerId === undefined) return platform === undefined ? undefined : { snapshot: platform, source: 'platform' };
    const onPlatform = env === undefined ? undefined : (modelId: string, tier: EffortTier, effort: ReasoningEffort | undefined) => envSnapshot(env, { defaultModel: modelId }, tier, effort);
    return resolveFastModel(store, ownerId, platform, tierOf(lane), onPlatform);
  }

  /**
   * The owner's snapshot for a lane: the lane's tier row (its model, its effort) over the main model. A row naming a provider the
   * owner no longer has is ignored (its effort belonged to that model).
   */
  async function resolveForOwner(ownerId: string, lane: EffortLane): Promise<ModelSnapshot> {
    const tier = tierOf(lane);
    const controls = await readAccountSettings(store, ownerId);
    const row = controls?.tiers?.[tierNameOf(lane)];
    if (row === undefined || (row.modelId === undefined && row.effort === undefined)) return mainSnapshot(ownerId, controls, tier, undefined);
    if (row.modelId === undefined) return mainSnapshot(ownerId, controls, tier, row.effort);
    if (row.providerId !== undefined && (await readOwnedProvider(store, ownerId, row.providerId)) === undefined) return mainSnapshot(ownerId, controls, tier, undefined);
    return mainSnapshot(ownerId, { ...controls, defaultModel: row.modelId, providerId: row.providerId ?? null }, tier, row.effort);
  }

  /** The snapshot of the controls' model: the owner's provider, else the platform default. */
  async function mainSnapshot(ownerId: string, controls: ModelRuntimeControls | undefined, tier: EffortTier, effort: ReasoningEffort | undefined): Promise<ModelSnapshot> {
    if (controls?.providerId) {
      const owned = await ownerProviderSnapshot(store, ownerId, { ...controls, providerId: controls.providerId }, tier, effort);
      if (owned !== undefined) return owned;
      // The chosen provider was removed: same as none chosen, and its model means nothing on the platform default.
      if (env === undefined) throw modelProviderRequired();
      return envSnapshot(env, undefined, tier, undefined);
    }
    if (env === undefined) throw modelProviderRequired();
    return envSnapshot(env, controls, tier, effort);
  }

  /** The platform-default snapshot for one owner's stored controls. */
  async function envSnapshot(envConfig: ModelEnv, controls: ModelRuntimeControls | undefined, tier: EffortTier, effort: ReasoningEffort | undefined): Promise<ModelSnapshot> {
    const wanted = controls?.defaultModel ?? null;
    // The tier always needs the model's offered levels, so the catalog is always consulted (cached, never fatal).
    const loaded = await loadForSelection(catalog, wanted, true);
    // Only a fresh catalog describes the chosen model; a stale one covers the env default alone.
    const item = loaded?.fresh === true ? loaded.catalog.items.find((entry) => entry.id === (wanted ?? envConfig.modelId)) : undefined;
    // The env default always runs even when the catalog is temporarily unreachable; any other
    // unknown id fails clearly instead of silently falling back to a model nobody chose.
    if (wanted !== null && item === undefined && wanted !== envConfig.modelId) {
      if (loaded?.fresh === false) throw new ModelSelectionError('catalog-unavailable', 'Model catalog is unavailable; cannot confirm model "' + wanted + '"');
      throw new ModelSelectionError('unknown-model', 'Unknown model: ' + wanted);
    }
    const modelId = wanted ?? envConfig.modelId;
    const frozen = frozenOrThrow(freezeRuntimeControls(controls, item, modelId, config.MODEL_WIRE_API === 'responses' ? 'openai-responses' : 'openai-completions', tier, effort));
    const wire = config.MODEL_WIRE_API === 'responses' ? 'openai-responses' : 'openai-completions';
    // Native search needs the Responses wire: the vendor's own host, or a gateway that says its model has it.
    const capable = wire === 'openai-responses' && (item?.nativeWebSearch === true || endpointHasNativeSearch(wire, envConfig.baseUrl));
    const native = useNativeWebSearch(controls?.webSearch, capable) ? { nativeWebSearch: true as const } : {};
    // The platform default is a gateway of our own choosing, not a catalog entry: only a verified model id opts in.
    const toolSearch = resolveToolSearchMode({ api: wire, provider: 'openai', id: modelId }) === 'responses-tool-search' ? { toolSearch: 'responses-tool-search' as const } : {};
    return { ...snapshotFor(envConfig, modelId, item?.supportsImages ?? envConfig.supportsImages, frozen), ...native, ...toolSearch, ...snapshotPricingFragment(config.MODEL_PRICING_JSON, envConfig.baseUrl, modelId), ...fallbackFor(config, envConfig, modelId) };
  }
}
