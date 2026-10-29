// The built-in model providers an owner can add an own key for: pi-ai's generated catalog, filtered to
// the wires this backend speaks (openai-completions, openai-responses, anthropic-messages). Catalog
// facts (endpoint, context window, output maximum, price, vision and reasoning support) come from pi-ai,
// so compaction, pricing and capability checks keep working for a user-keyed model.
import { endpointHasNativeSearch } from './native-web-search.js';
import { measuredEfforts } from './model-catalog-fields.js';
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { builtinProviders, getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import type { BuiltinModelProvider, ModelCatalog, ModelCatalogItem, ReasoningEffort } from '@agent-desktop/public-contracts';

/** The wires this backend has a stream adapter for. A catalog model on any other api is not offered. */
export const SUPPORTED_BUILTIN_WIRES: ReadonlySet<string> = new Set(['openai-completions', 'openai-responses', 'anthropic-messages']);

const LEVELS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** A built-in chat model this backend can run: its catalog entry, on a supported wire. */
export type BuiltinChatModel = Model<Api>;

/** A provider id pi-ai's generated catalog knows; the guard narrows the id without a cast. */
function isBuiltinProvider(providerId: string): providerId is BuiltinProvider {
  return getBuiltinProviders().some((known) => known === providerId);
}

function supportedModels(providerId: string): BuiltinChatModel[] {
  if (!isBuiltinProvider(providerId)) return [];
  return getBuiltinModels(providerId).filter((model) => SUPPORTED_BUILTIN_WIRES.has(model.api));
}

let providerList: BuiltinModelProvider[] | undefined;

/** The built-in providers with at least one model on a supported wire. Computed once per process. */
export function listBuiltinProviders(): BuiltinModelProvider[] {
  if (providerList === undefined) {
    providerList = builtinProviders().flatMap((provider) => {
      const count = supportedModels(provider.id).length;
      return count === 0 ? [] : [{ id: provider.id, name: provider.name, authKinds: ['api_key' as const], modelCount: count }];
    });
  }
  return providerList;
}

let providerObjects: Map<string, Provider> | undefined;

/**
 * pi-ai's provider object for a built-in id. Calls stream through it, not the bare wire adapter, so a
 * vendor's required request decoration (OpenCode's session routing header) is applied.
 */
export function builtinProviderFor(providerId: string): Provider | undefined {
  if (providerObjects === undefined) providerObjects = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  return isBuiltinProviderId(providerId) ? providerObjects.get(providerId) : undefined;
}

export function isBuiltinProviderId(providerId: string): boolean {
  return listBuiltinProviders().some((provider) => provider.id === providerId);
}

/** One catalog model of a built-in provider, or undefined when the provider or model is unknown. */
export function findBuiltinModel(providerId: string, modelId: string): BuiltinChatModel | undefined {
  if (!isBuiltinProviderId(providerId)) return undefined;
  return supportedModels(providerId).find((model) => model.id === modelId);
}

/** The reasoning efforts a catalog model accepts. A non-reasoning model offers none. */
export function builtinReasoningEfforts(model: BuiltinChatModel): ReasoningEffort[] {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap ?? {};
  return LEVELS.filter((level) => map[level] !== null);
}

/**
 * The small, fast model recommended for background work, per provider family (BACKEND §10.14). Only a model the
 * pi-ai catalog actually lists for that provider is ever marked, so a catalog update that drops one just unmarks it.
 */
const CHEAP_MODELS: Readonly<Record<string, string>> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5.4-mini',
  'github-copilot': 'claude-haiku-4.5',
  deepseek: 'deepseek-flash',
  opencode: 'qwen3.8-flash',
  'opencode-go': 'qwen3.8-flash',
  openrouter: 'google/gemini-3.5-flash-lite',
  'vercel-ai-gateway': 'google/gemini-3.5-flash-lite',
  zai: 'glm-5.3-flash',
  xiaomi: 'mimo-v2.6-flash',
};

/** The recommended cheap model id of a built-in provider, or undefined when none is marked or the catalog lacks it. */
export function cheapModelId(providerId: string): string | undefined {
  const id = CHEAP_MODELS[providerId];
  return id !== undefined && findBuiltinModel(providerId, id) !== undefined ? id : undefined;
}

/** The public catalog item for one built-in model. */
export function builtinCatalogItem(model: BuiltinChatModel, cheap = false): ModelCatalogItem {
  // Our own measurements of a model's levels beat pi-ai's table (it lacks Muse Spark's `max` and Luna's `none` on OpenCode).
  const measured = model.reasoning ? measuredEfforts(model.id) : undefined;
  // pi-ai's map names the wire value for "no thinking" (`off`) only on a model that accepts it.
  const noReasoning = measured?.noReasoning ?? (model.reasoning && typeof model.thinkingLevelMap?.off === 'string');
  return {
    id: model.id,
    name: model.name,
    supportsImages: model.input.includes('image'),
    reasoningEfforts: measured?.efforts ?? builtinReasoningEfforts(model),
    ...(noReasoning ? { noReasoning: true as const } : {}),
    ...(cheap ? { cheap: true as const } : {}),
    ...(endpointHasNativeSearch(model.api, model.baseUrl) ? { nativeWebSearch: true as const } : {}),
  };
}

/** The catalog of one built-in provider; the first model is its default. Undefined for an unknown provider. */
export function builtinCatalog(providerId: string): ModelCatalog | undefined {
  if (!isBuiltinProviderId(providerId)) return undefined;
  const cheap = cheapModelId(providerId);
  const items = supportedModels(providerId).map((model) => builtinCatalogItem(model, model.id === cheap));
  const first = items[0];
  if (first === undefined) return undefined;
  return { defaultModel: first.id, items };
}
