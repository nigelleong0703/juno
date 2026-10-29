import { modelWireSchema, type ReasoningEffort } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import { builtinCatalogItem, findBuiltinModel } from './builtin-providers.js';
import { freezeRuntimeControls, type FreezeRuntimeControlsResult, type FrozenRuntimeControls, type ModelRuntimeControls } from './model-runtime-settings.js';
import { ModelSelectionError } from './model-selection-error.js';
import type { ModelSnapshot } from './model-selection.js';
import { readOwnedProvider } from './user-providers.js';
import { endpointHasNativeSearch, useNativeWebSearch } from './native-web-search.js';
import { resolveToolSearchMode } from './tool-search-mode.js';
import type { EffortTier } from './reasoning-tier.js';

/** A rejected or unverifiable reasoning control is a loud, terminal misconfiguration. */
export function frozenOrThrow(result: FreezeRuntimeControlsResult): FrozenRuntimeControls {
  if (result.kind === 'frozen') return result.controls;
  if (result.kind === 'rejected-reasoning') {
    throw new ModelSelectionError(
      'unsupported-reasoning',
      'Model "' + result.modelId + '" does not offer reasoning effort "' + result.effort + '"',
    );
  }
  throw new ModelSelectionError(
    'unverified-reasoning',
    'Cannot verify reasoning effort "' + result.effort + '" for model "' + result.modelId + '": the model catalog did not describe its reasoning support',
  );
}

/**
 * Snapshot for an owner's own provider: the model is frozen against its catalog, the endpoint comes
 * from its document. Undefined when the chosen provider no longer exists (deleted after it was chosen).
 */
export async function ownerProviderSnapshot(store: Store, ownerId: string, controls: ModelRuntimeControls & { providerId: string }, tier: EffortTier, effort?: ReasoningEffort): Promise<ModelSnapshot | undefined> {
  const record = await readOwnedProvider(store, ownerId, controls.providerId);
  if (record === undefined) return undefined;
  const modelId = controls.defaultModel;
  if (modelId === null) throw new ModelSelectionError('invalid-model', 'Choose a model for the selected provider in Settings > Models');
  if (record.kind === 'builtin') {
    const model = record.providerId === undefined ? undefined : findBuiltinModel(record.providerId, modelId);
    if (model === undefined) throw new ModelSelectionError('unknown-model', 'Unknown model: ' + modelId);
    const item = builtinCatalogItem(model);
    const wire = modelWireSchema.safeParse(model.api);
    if (!wire.success) throw new ModelSelectionError('unknown-model', 'Model "' + modelId + '" uses a wire this backend does not speak');
    const frozen = frozenOrThrow(freezeRuntimeControls(controls, item, modelId, wire.data, tier, effort));
    const native = useNativeWebSearch(controls.webSearch, endpointHasNativeSearch(wire.data, model.baseUrl));
    return {
      modelId,
      baseUrl: model.baseUrl,
      supportsImages: item.supportsImages,
      providerId: record.id,
      wire: wire.data,
      limits: { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens },
      ...(Object.keys(frozen).length > 0 ? { controls: frozen } : {}),
      pricing: model.cost,
      ...(native ? { nativeWebSearch: true as const } : {}),
      ...(resolveToolSearchMode(model) === 'responses-tool-search' ? { toolSearch: 'responses-tool-search' as const } : {}),
    };
  }
  if (record.baseUrl === undefined || record.wire === undefined) throw new ModelSelectionError('unknown-provider', 'The selected model provider is incomplete');
  // A custom catalog is not published, so an effort the owner set cannot be verified and is refused.
  const frozen = frozenOrThrow(freezeRuntimeControls(controls, undefined, modelId, record.wire, tier, effort));
  // A custom endpoint counts only when it is the vendor's own host; a proxy is never assumed to forward the search tool.
  const native = useNativeWebSearch(controls.webSearch, endpointHasNativeSearch(record.wire, record.baseUrl));
  return {
    modelId,
    baseUrl: record.baseUrl,
    supportsImages: false,
    providerId: record.id,
    wire: record.wire,
    ...(Object.keys(frozen).length > 0 ? { controls: frozen } : {}),
    ...(native ? { nativeWebSearch: true as const } : {}),
  };
}
