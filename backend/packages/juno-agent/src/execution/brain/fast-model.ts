// The fast model: the account's model for background one-shots (run titles, role suggestions, purchase and
// dialog review, memory jobs). One resolver, used by every caller (BACKEND §10.14).
import { settingsIdFor } from '@agent-desktop/public-contracts';
import type { EffectiveFastModel, ReasoningEffort } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { cheapModelId } from './builtin-providers.js';
import { readStoredModelSettings, type ModelRuntimeControls } from './model-runtime-settings.js';
import type { ModelEnv } from './model-catalog.js';
import type { ModelSnapshot } from './model-selection.js';
import { ownerProviderSnapshot } from './owner-snapshot.js';
import { readOwnedProvider } from './user-providers.js';
import type { EffortTier } from './reasoning-tier.js';

export interface FastModelSelection {
  snapshot: ModelSnapshot;
  source: EffectiveFastModel['source'];
}

/** A step that cannot produce a snapshot (provider deleted, model gone, bad controls) just falls through to the next. */
async function attempt(step: () => Promise<ModelSnapshot | undefined>): Promise<ModelSnapshot | undefined> {
  try {
    return await step();
  } catch {
    return undefined;
  }
}

/**
 * Order: the owner's `fast` tier model (and effort), the platform's fast model (when configured), the cheap-marked model of
 * the owner's default provider, the owner's agent model. Undefined when none applies; the caller then falls back to
 * the platform's main model if it has one.
 */
export async function resolveFastModel(
  store: Store,
  ownerId: string,
  platform: ModelSnapshot | undefined,
  tier: EffortTier,
  /** Builds a snapshot of a model on the platform default endpoint (a `fast` row that names a model without a provider); absent when there is none. */
  platformModel?: (modelId: string, tier: EffortTier, effort: ReasoningEffort | undefined) => Promise<ModelSnapshot>,
): Promise<FastModelSelection | undefined> {
  const stored = readStoredModelSettings(await store.get('settings', settingsIdFor(ownerId)));
  const controls: ModelRuntimeControls | undefined = stored.kind === 'controls' ? stored.controls : undefined;
  const pick = controls?.tiers?.fast;
  if (pick?.modelId !== undefined) {
    const { modelId, providerId, effort } = pick;
    const snapshot = providerId === undefined
      ? platformModel === undefined ? undefined : await attempt(() => platformModel(modelId, tier, effort))
      : await attempt(() => ownerProviderSnapshot(store, ownerId, { defaultModel: modelId, providerId }, tier, effort));
    if (snapshot !== undefined) return { snapshot, source: 'chosen' };
  }
  if (platform !== undefined) return { snapshot: platform, source: 'platform' };
  const providerId = controls?.providerId;
  if (!providerId) return undefined;
  const record = await readOwnedProvider(store, ownerId, providerId);
  // A ChatGPT sign-in offers only its plan's models, which the static cheap table cannot know.
  const cheap = record?.kind === 'builtin' && record.auth !== 'chatgpt' && record.providerId !== undefined ? cheapModelId(record.providerId) : undefined;
  if (cheap !== undefined) {
    const snapshot = await attempt(() => ownerProviderSnapshot(store, ownerId, { defaultModel: cheap, providerId }, tier));
    if (snapshot !== undefined) return { snapshot, source: 'cheap' };
  }
  const snapshot = await attempt(() => ownerProviderSnapshot(store, ownerId, { defaultModel: controls?.defaultModel ?? null, providerId }, tier));
  return snapshot === undefined ? undefined : { snapshot, source: 'agent' };
}

/** The public description of a resolved fast model. */
export function describeFastModel(selection: FastModelSelection | undefined): EffectiveFastModel | null {
  return selection === undefined ? null : { providerId: selection.snapshot.providerId ?? null, modelId: selection.snapshot.modelId, source: selection.source };
}

/**
 * The platform's own fast model (FAST_MODEL_*), platform-paid, or undefined when FAST_MODEL_ID is blank.
 * A blank FAST_MODEL_BASE_URL / FAST_MODEL_API_KEY reuses the main platform endpoint's.
 */
export function readFastModelEnv(config: Partial<Record<'FAST_MODEL_ID' | 'FAST_MODEL_BASE_URL' | 'FAST_MODEL_API_KEY' | 'MODEL_BASE_URL' | 'MODEL_API_KEY', unknown>>): ModelEnv | undefined {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const modelId = text(config.FAST_MODEL_ID);
  const baseUrl = text(config.FAST_MODEL_BASE_URL) || text(config.MODEL_BASE_URL);
  if (modelId === '' || baseUrl === '') return undefined;
  return { modelId, baseUrl, apiKey: text(config.FAST_MODEL_API_KEY) || text(config.MODEL_API_KEY) || 'none', supportsImages: false };
}
