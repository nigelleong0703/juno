/**
 * Shared fixtures for the account-global model runtime-control tests. Kept out of the *.test.ts
 * files so each of them stays under the 200-line core gate.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { AssistantTurn, BrainContext, Store } from '../../../contracts/index.js';
import type { AppSettings, ModelSettings } from '@agent-desktop/public-contracts';
import { createBrain } from '../index.js';
import { backendConfigSchema } from '../../config.js';
import { runWithOwner } from '../../../owner-context.js';
import { createModelCatalogLoader, type ModelEnv } from '../model-catalog.js';
import { createAccountModelSelection, type ModelSnapshot } from '../model-selection.js';
import type { LimitsAwareProvider } from '../model-limits.js';

export const ENV: ModelEnv = {
  modelId: 'env-default',
  baseUrl: 'http://provider.test/v1',
  apiKey: 'secret-key-xyz',
  supportsImages: false,
};

/** `ultra` is advertised upstream but is not a pi-ai level, so the catalog must drop it. */
export const UPSTREAM_DOC = {
  data: [
    { id: 'env-default', name: 'Env Default' },
    {
      id: 'reasoner',
      name: 'Reasoner',
      capabilities: { supports_reasoning: true, reasoning_effort: ['low', 'high', 'ultra'] },
    },
    { id: 'plain', name: 'Plain', capabilities: { supports_reasoning: false, supports_tool_use: true } },
    { id: 'quiet', name: 'Quiet' },
  ],
};

const BASE_SETTINGS: Omit<AppSettings, 'models'> = {
  general: { launchAtLogin: false, language: 'en' },
  appearance: { theme: 'system', density: 'comfortable', accent: '#0066cc' },
  notifications: [],
  yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
  connections: { serverUrl: 'http://localhost:8787', modelProviders: [] },
  privacy: { dataRetentionDays: 90, trainingOptIn: false },
  advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
};


export function stubTurn(): AssistantTurn {
  return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, stopReason: 'stop' };
}

/** Exactly the parameters the run's model call would send. */
export interface BoundCall {
  modelId: string;
  controls: { reasoningEffort?: string; temperature?: number; maxOutputTokens?: number } | undefined;
}

export interface Fixture {
  store: Store;
  brain: Awaited<ReturnType<typeof createBrain>>;
  bound: BoundCall[];
  resolveCount: () => number;
  setModels: (ownerId: string, models: ModelSettings | null) => Promise<void>;
  setLegacy: (ownerId: string) => Promise<void>;
}

function stubProviderFor(snapshot: ModelSnapshot, bound: BoundCall[]): LimitsAwareProvider {
  return {
    async getLimits() {
      return { contextWindow: 8000, maxOutputTokens: 500 };
    },
    async call() {
      bound.push({ modelId: snapshot.modelId, controls: snapshot.controls });
      return stubTurn();
    },
  };
}

export async function setup(fetchImpl?: typeof fetch): Promise<Fixture> {
  const store = createMemoryStore();
  const bound: BoundCall[] = [];
  let resolves = 0;
  const fetchFn: typeof fetch =
    fetchImpl ??
    (async () => new Response(JSON.stringify(UPSTREAM_DOC), { headers: { 'content-type': 'application/json' } }));
  const catalog = createModelCatalogLoader(ENV, fetchFn);
  const inner = createAccountModelSelection({
    store,
    config: backendConfigSchema.parse({}),
    env: ENV,
    catalog,
    createProvider: (snapshot) => stubProviderFor(snapshot, bound),
  });
  const selection = {
    resolve: async (agentId: string) => {
      resolves += 1;
      return inner.resolve(agentId);
    },
    providerFor: (snapshot: ModelSnapshot) => inner.providerFor(snapshot),
  };
  const bootstrap = stubProviderFor({ modelId: 'bootstrap', baseUrl: ENV.baseUrl, supportsImages: false }, []);
  const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: bootstrap, modelSelection: selection });
  const put = async (ownerId: string, row: AppSettings): Promise<void> => {
    await store.put('settings', { id: 'app-settings-' + ownerId, ...row });
  };
  return {
    store,
    brain,
    bound,
    resolveCount: () => resolves,
    setModels: (ownerId, models) => put(ownerId, models === null ? BASE_SETTINGS : { ...BASE_SETTINGS, models }),
    setLegacy: (ownerId) => put(ownerId, BASE_SETTINGS),
  };
}

export function buildFor(fixture: Fixture, ownerId: string, agentId: string, previousContext?: BrainContext) {
  return runWithOwner(ownerId, () =>
    fixture.brain.buildContext({
      agentId,
      conversationId: 'c1',
      sessionKey: agentId + ':c1',
      wake: [],
      ...(previousContext === undefined ? {} : { previousContext }),
    }),
  );
}

export const REASONER: ModelSettings = {
  defaultModel: 'reasoner',
  tiers: { chat: { effort: 'high' } },
  temperature: 0.2,
  maxOutputTokens: 300,
};

export const failingFetch: typeof fetch = async () => {
  throw new Error('catalog down');
};
