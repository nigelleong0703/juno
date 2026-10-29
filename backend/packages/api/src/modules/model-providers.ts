/**
 * Owner-scoped model providers: the built-in providers and custom OpenAI-compatible endpoints an owner
 * adds with their own API key. The key is sealed (enc:v1:, SECRETS_KEY) before the write and is never
 * returned: every record leaves through toPublicModelProvider. A custom baseUrl is refused at save time
 * when it names a private host (the call path re-checks each hop with DNS pinning).
 */
import { randomUUID } from 'node:crypto';
import type { Store } from '@agent-desktop/contracts';
import { NotFoundError } from '@agent-desktop/contracts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import { modelUrlRefused } from '@agent-desktop/contracts/mcp';
import { toPublicModelProvider, type ModelProviderRecord } from '@agent-desktop/contracts/model-providers';
import { builtinModelProviderListSchema, settingsIdFor, effectiveTiersSchema, effectiveSystemOneModelSchema, modelCatalogSchema } from '@agent-desktop/public-contracts';
import type {
  BuiltinModelProvider,
  CreateModelProviderInput,
  EffectiveTiers,
  EffectiveSystemOneModel,
  ModelCatalog,
  ModelProvider,
  ModelProviderList,
  UpdateModelProviderInput,
} from '@agent-desktop/public-contracts';

/** Lists built-in providers and provider catalogs. Implemented against agentd (the pi-ai registry). */
export interface ModelProviderCatalogClient {
  builtinProviders(ownerId: string): Promise<BuiltinModelProvider[]>;
  /** A provider's model catalog; `not-found` for an unknown or foreign provider, `unavailable` on upstream failure. */
  providerModels(ownerId: string, providerId: string): Promise<{ kind: 'ok'; catalog: ModelCatalog } | { kind: 'not-found' } | { kind: 'unavailable' }>;
  /** The four tiers as they resolve for this owner now; null on upstream failure. */
  effectiveTiers(ownerId: string): Promise<EffectiveTiers | null>;
  /** The System One model decisions would use for this owner now (possibly the fast model emulating one); null when none. */
  effectiveSystemOneModel(ownerId: string): Promise<EffectiveSystemOneModel | null>;
  /** Tells agentd the owner chose their model, so a new account's unanswered first-run greeting can run (best effort; never throws). */
  modelChosen?(ownerId: string, providerId: string): Promise<void>;
}

/** A configuration problem the route reports as 400 with its code (never silently dropped input). */
export class ModelProviderConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ModelProviderConfigError';
  }
}

export interface ModelProvidersModule {
  list(platformDefault: boolean): Promise<ModelProviderList>;
  create(input: CreateModelProviderInput): Promise<ModelProvider>;
  update(id: string, input: UpdateModelProviderInput): Promise<ModelProvider>;
  remove(id: string): Promise<void>;
}

export function createModelProvidersModule(scoped: Store, ownerId: string, client: ModelProviderCatalogClient): ModelProvidersModule {
  return {
    async list(platformDefault) {
      const page = await scoped.list('modelProviders', { limit: 200 });
      const providers = page.items.map((record) => toPublicModelProvider(record));
      // A run reads only the chosen provider and model (settings.models), so a provider that is merely saved is not enough.
      const chosen = (await scoped.get('settings', settingsIdFor(ownerId)))?.models;
      const ready = providers.some((provider) => provider.id === chosen?.providerId && provider.hasKey && provider.kind !== 'systemone') && Boolean(chosen?.defaultModel);
      return { providers, platformDefault, usable: platformDefault || ready };
    },

    async create(input) {
      const now = new Date().toISOString();
      const base = { id: 'mprov-' + randomUUID(), ownerId, apiKey: encryptSecret(input.apiKey), createdAt: now, updatedAt: now };
      let record: ModelProviderRecord;
      if (input.kind === 'builtin') {
        const known = (await client.builtinProviders(ownerId)).find((provider) => provider.id === input.providerId);
        if (known === undefined) throw new ModelProviderConfigError('UNKNOWN_PROVIDER', 'Unknown built-in provider');
        record = { ...base, kind: 'builtin', name: known.name, providerId: known.id };
      } else if (input.kind === 'systemone') {
        if (modelUrlRefused(input.baseUrl)) throw new ModelProviderConfigError('MODEL_URL_BLOCKED', 'The System One endpoint must be a public http(s) address');
        record = { ...base, kind: 'systemone', name: input.name, baseUrl: input.baseUrl, models: [...new Set(input.models)] };
      } else {
        if (modelUrlRefused(input.baseUrl)) throw new ModelProviderConfigError('MODEL_URL_BLOCKED', 'The model endpoint must be a public http(s) address');
        record = { ...base, kind: 'custom', name: input.name, baseUrl: input.baseUrl, wire: input.wire };
      }
      return toPublicModelProvider(await scoped.put('modelProviders', record));
    },

    async update(id, input) {
      const current = await scoped.get('modelProviders', id);
      if (current === null) throw new NotFoundError('modelProviders', id);
      if (input.models !== undefined && current.kind !== 'systemone') throw new ModelProviderConfigError('NOT_SYSTEMONE', 'Only a System One provider lists models');
      if (input.wire !== undefined && current.kind === 'systemone') throw new ModelProviderConfigError('SYSTEMONE_NO_WIRE', 'A System One provider has no wire');
      if (input.baseUrl !== undefined || input.wire !== undefined) {
        if (current.kind === 'builtin') throw new ModelProviderConfigError('BUILTIN_ENDPOINT_FIXED', 'A built-in provider endpoint cannot be changed');
      }
      if (input.baseUrl !== undefined && modelUrlRefused(input.baseUrl)) {
        throw new ModelProviderConfigError('MODEL_URL_BLOCKED', 'The model endpoint must be a public http(s) address');
      }
      const patch: Partial<ModelProviderRecord> = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.wire === undefined ? {} : { wire: input.wire }),
        ...(input.models === undefined ? {} : { models: [...new Set(input.models)] }),
        ...(input.apiKey === undefined ? {} : { apiKey: encryptSecret(input.apiKey) }),
        updatedAt: new Date().toISOString(),
      };
      return toPublicModelProvider(await scoped.patch('modelProviders', id, patch));
    },

    async remove(id) {
      const current = await scoped.get('modelProviders', id);
      if (current === null) throw new NotFoundError('modelProviders', id);
      await scoped.delete('modelProviders', id);
    },
  };
}


export interface AgentdProviderClientDeps {
  agentdUrl: string;
  internalToken: string;
  fetchFn: typeof fetch;
  timeoutMs?: number;
}

/**
 * The agentd-backed catalog client: the same bearer and owner headers as the platform catalog loader.
 * Any transport or shape failure is `unavailable`, so upstream bodies and statuses never reach a client.
 */
export function createAgentdModelProviderClient(deps: AgentdProviderClientDeps): ModelProviderCatalogClient {
  const base = deps.agentdUrl.replace(/\/$/, '') + '/v1/model-providers';
  const get = async (ownerId: string, path: string): Promise<{ status: number; body: unknown } | null> => {
    try {
      const response = await deps.fetchFn(base + path, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + deps.internalToken, 'x-owner-id': ownerId },
        redirect: 'manual',
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      });
      if (response.status === 404) return { status: 404, body: null };
      if (!response.ok) return null;
      return { status: response.status, body: await response.json() };
    } catch {
      return null;
    }
  };
  return {
    async builtinProviders(ownerId) {
      const answer = await get(ownerId, '/builtin');
      const parsed = builtinModelProviderListSchema.safeParse(answer?.body);
      return parsed.success ? parsed.data.items : [];
    },
    async providerModels(ownerId, providerId) {
      const answer = await get(ownerId, '/' + encodeURIComponent(providerId) + '/models');
      if (answer === null) return { kind: 'unavailable' };
      if (answer.status === 404) return { kind: 'not-found' };
      const parsed = modelCatalogSchema.safeParse(answer.body);
      return parsed.success ? { kind: 'ok', catalog: parsed.data } : { kind: 'unavailable' };
    },
    async effectiveTiers(ownerId) {
      const parsed = effectiveTiersSchema.safeParse((await get(ownerId, '/tiers'))?.body);
      return parsed.success ? parsed.data : null;
    },
    async modelChosen(ownerId, providerId) {
      await deps.fetchFn(deps.agentdUrl.replace(/\/$/, '') + '/v1/onboarding/model-chosen', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + deps.internalToken, 'x-owner-id': ownerId, 'content-type': 'application/json' },
        body: JSON.stringify({ providerId }),
        redirect: 'manual',
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      }).then((response) => response.body?.cancel()).catch(() => undefined);
    },
    async effectiveSystemOneModel(ownerId) {
      const parsed = effectiveSystemOneModelSchema.safeParse((await get(ownerId, '/system-one'))?.body);
      return parsed.success ? parsed.data : null;
    },
  };
}
