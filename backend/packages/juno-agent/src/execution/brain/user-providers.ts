// An owner's own model provider as a per-call model source. The credential is read from the owner's
// provider document on every call (never cached in a snapshot or a provider object), and the endpoint is
// checked against that document, so a changed, deleted or re-keyed provider takes effect on the next call.
import type { ModelProviderRecord } from '../../contracts/model-providers.js';
import type { Store } from '../../contracts/index.js';
import { openProviderKey, readOwnedProvider, sealProviderKey } from './provider-secrets.js';
export { openProviderKey, readOwnedProvider, sealProviderKey };
import type { ReasoningEffort, ModelWire } from '@agent-desktop/public-contracts';
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { createModelFetch } from '../../modules/tools/net/guardedFetch.js';
import { builtinProviderFor, findBuiltinModel } from './builtin-providers.js';
import { createLimitsSourceFor, type ModelLimits, type ModelLimitsSource } from './model-limits.js';
import { ModelSelectionError } from './model-selection-error.js';
import { ProviderFailureError } from './model-failure.js';
import { responsesModelFor, wireModelFor, type WireModelRequest } from './provider-wire-compat.js';
import { chatGPTAccessToken, pinnedChatGPTRefresh, REAUTH_MESSAGE, type ChatGPTRefresh } from './chatgpt-credential.js';
import { createModelProvider, type ModelProvider, type ModelSource, type OpenAIProviderOptions, type ResolvedCall } from './provider.js';

/** What a frozen run snapshot carries about an owner's provider; never the key. */
export interface UserProviderBinding {
  providerId: string;
  modelId: string;
  baseUrl: string;
  wire: ModelWire;
  supportsImages: boolean;
  reasoningEffort?: ReasoningEffort;
  omitReasoning?: boolean;
  /** Built-in models: limits frozen at resolve time. Custom endpoints probe their limits per call. */
  limits?: ModelLimits;
}

interface EndpointTarget {
  baseUrl: string;
  wire: Api;
  /** Builds the pi-ai model for one call. Built-in models are the catalog entry itself. */
  build(limits: ModelLimits): Model<Api>;
  custom: boolean;
  /** Built-in models stream through their own pi-ai provider (vendor-required headers). */
  provider?: Provider;
}

/** The endpoint a provider document currently describes for one model, or undefined when it no longer offers it. */
function targetOf(record: ModelProviderRecord, binding: UserProviderBinding): EndpointTarget | undefined {
  if (record.kind === 'builtin') {
    const model = record.providerId === undefined ? undefined : findBuiltinModel(record.providerId, binding.modelId);
    const provider = record.providerId === undefined ? undefined : builtinProviderFor(record.providerId);
    if (model === undefined || provider === undefined) return undefined;
    return { baseUrl: model.baseUrl, wire: model.api, build: () => model, custom: false, provider };
  }
  if (record.baseUrl === undefined || record.wire === undefined) return undefined;
  const request = (limits: ModelLimits): WireModelRequest => ({
    modelId: binding.modelId,
    baseUrl: record.baseUrl ?? '',
    supportsImages: binding.supportsImages,
    ...(binding.reasoningEffort === undefined ? {} : { reasoningEffort: binding.reasoningEffort }),
    ...(binding.omitReasoning === true ? { omitReasoning: true } : {}),
    limits,
    providerName: 'custom:' + record.id,
  });
  const wire = record.wire;
  return {
    baseUrl: record.baseUrl,
    wire,
    build: (limits) => (wire === 'openai-responses' ? responsesModelFor(request(limits)) : wireModelFor(request(limits))),
    custom: true,
  };
}

/**
 * The per-call source for one bound provider. `ownerId` is read at call time: a call with no owner
 * scope fails closed rather than reading another owner's document.
 */
export function userProviderSource(deps: { store: Store; binding: UserProviderBinding; ownerId: () => string | undefined; refresh?: ChatGPTRefresh }): ModelSource {
  const { store, binding } = deps;
  const resolve = async (): Promise<ResolvedCall> => {
    const ownerId = deps.ownerId();
    if (ownerId === undefined) throw new ModelSelectionError('unknown-provider', 'Model provider cannot be used outside an owner scope');
    const record = await readOwnedProvider(store, ownerId, binding.providerId);
    if (record === undefined) throw new ModelSelectionError('unknown-provider', 'The model provider for this run is no longer configured');
    const target = targetOf(record, binding);
    if (target === undefined) throw new ModelSelectionError('unknown-model', 'Model "' + binding.modelId + '" is no longer offered by this provider');
    if (target.baseUrl !== binding.baseUrl || target.wire !== binding.wire) {
      throw new ModelSelectionError('endpoint-changed', 'Model provider endpoint changed since this run started; refusing to redirect silently');
    }
    if (record.status === 'reauth_required') throw new ModelSelectionError('reauth-required', REAUTH_MESSAGE);
    if (record.auth === 'chatgpt') {
      // The ChatGPT token is refreshed when near expiry; a refused refresh is terminal (see chatgpt-credential.ts).
      const apiKey = await chatGPTAccessToken({ store, ownerId, record, refresh: deps.refresh ?? pinnedChatGPTRefresh });
      return { apiKey, buildModel: (limits) => target.build(limits), ...(target.provider ? { provider: target.provider } : {}) };
    }
    if (record.apiKey.length === 0) {
      throw new ModelSelectionError('provider-key-missing', 'No API key is stored for this model provider; add one in Settings > Models');
    }
    let apiKey: string;
    try {
      apiKey = openProviderKey(record.apiKey);
    } catch {
      throw new ModelSelectionError('provider-key-unreadable', 'The stored API key for this model provider cannot be read; enter it again in Settings > Models');
    }
    return { apiKey, buildModel: (limits) => target.build(limits), ...(target.provider ? { provider: target.provider } : {}) };
  };
  const limits: ModelLimitsSource = binding.limits !== undefined && !isCustom(binding)
    ? { getLimits: async () => binding.limits ?? {} }
    : createLimitsSourceFor({
      baseUrl: binding.baseUrl,
      modelId: binding.modelId,
      apiKey: async () => (await resolve()).apiKey,
      fetch: createModelFetch(),
    });
  return {
    resolve,
    limits,
    // A custom owner endpoint is reached through the SSRF-guarded client (name and per-hop address checks).
    ...(isCustom(binding) ? { fetch: createModelFetch() } : {}),
    sessionIdBody: true,
    textOnlyHint: 'Choose a model that accepts images for this provider.',
  };
}

/** A binding is custom when it carries no frozen catalog limits (built-in models always do). */
function isCustom(binding: UserProviderBinding): boolean {
  return binding.limits === undefined;
}

/** Owner-visible provider failures: a rejected or exhausted key is named, never mistaken for a platform outage. */
function withUserKeyMessage(error: unknown): unknown {
  if (!(error instanceof ProviderFailureError)) return error;
  if (error.failure.kind === 'auth') {
    return new ProviderFailureError({ ...error.failure, message: 'Your model provider rejected the API key. Check or replace the key for this provider in Settings > Models.' });
  }
  if (error.failure.kind === 'quota') {
    return new ProviderFailureError({ ...error.failure, message: 'Your model provider reports that the quota for this API key is exhausted. Check the key\'s billing in Settings > Models.' });
  }
  return error;
}

/** The model provider for one bound owner provider. Its failures name the user's own key. */
export function createUserProvider(deps: { store: Store; binding: UserProviderBinding; ownerId: () => string | undefined; refresh?: ChatGPTRefresh }, options: OpenAIProviderOptions): ModelProvider {
  const provider = createModelProvider(userProviderSource(deps), options);
  return {
    getLimits: () => (provider.getLimits ? provider.getLimits() : Promise.resolve({})),
    async call(callOptions) {
      try {
        return await provider.call(callOptions);
      } catch (error) {
        throw withUserKeyMessage(error);
      }
    },
  };
}
