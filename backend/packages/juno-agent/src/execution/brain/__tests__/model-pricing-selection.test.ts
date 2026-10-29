/**
 * LOOP-COST1 account selection pricing: explicit rates freeze onto the run snapshot once per
 * new run (isolation per endpoint/model, unknown stays unknown), replay reuses the frozen
 * snapshot even after the pricing source changes, and endpoint drift still fails loudly.
 */
import { describe, expect, it } from 'vitest';
import type { Store } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { backendConfigSchema } from '../../config.js';
import { createModelCatalogLoader, type ModelEnv } from '../model-catalog.js';
import { appSettingsSchema } from '@agent-desktop/public-contracts';
import { createAccountModelSelection, ModelSelectionError, parseModelSnapshot, withFallbackModel, type ModelSnapshot } from '../model-selection.js';
import type { LimitsAwareProvider } from '../model-limits.js';

const ENV: ModelEnv = {
  modelId: 'env-default',
  baseUrl: 'http://provider.test/v1',
  apiKey: 'secret-key-xyz',
  supportsImages: false,
};

const PRICED = { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5 };
const OTHER = { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 };

const UPSTREAM_DOC = {
  data: [
    { id: 'env-default', name: 'Env Default' },
    { id: 'reasoner', name: 'Reasoner' },
    { id: 'plain', name: 'Plain' },
  ],
};

function pricingJson(rates: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>): string {
  return JSON.stringify(
    Object.entries(rates).map(([modelId, pricing]) => ({ baseUrl: ENV.baseUrl, modelId, ...pricing })),
  );
}

function stubProvider(): LimitsAwareProvider {
  return {
    async getLimits() {
      return {};
    },
    async call() {
      return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'stop' as const };
    },
  };
}

async function putModels(store: Store, ownerId: string, models: { defaultModel: string | null }): Promise<void> {
  const doc = { ...appSettingsSchema.parse({
    general: { launchAtLogin: false, language: 'en' },
    appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
    notifications: [],
    yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
    connections: { serverUrl: '', modelProviders: [] },
    privacy: { dataRetentionDays: 90, trainingOptIn: false },
    advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
  }), models, id: 'app-settings-' + ownerId };
  await store.put('settings', doc);
}

async function setup(pricing: string, captured: ModelSnapshot[] = [], env: ModelEnv = ENV) {
  const store = createMemoryStore();
  const config = backendConfigSchema.parse({ MODEL_PRICING_JSON: pricing });
  const catalog = createModelCatalogLoader(env, async () => new Response(JSON.stringify(UPSTREAM_DOC), { headers: { 'content-type': 'application/json' } }));
  const selection = createAccountModelSelection({
    store,
    config,
    env,
    catalog,
    createProvider: (snapshot) => {
      captured.push(snapshot);
      return stubProvider();
    },
  });
  return { store, selection };
}

describe('account selection pricing freeze', () => {
  it('freezes pricing for the env default on owner-less legacy contexts', async () => {
    const { selection } = await setup(pricingJson({ 'env-default': PRICED }));
    const snapshot = await selection.resolve('ghost-agent');
    expect(snapshot.modelId).toBe('env-default');
    expect(snapshot.pricing).toEqual(PRICED);
    expect(JSON.stringify(snapshot)).not.toContain(ENV.apiKey);
  });

  it('isolates pricing per selected model and leaves unpriced models unknown', async () => {
    const { store, selection } = await setup(pricingJson({ reasoner: PRICED, 'env-default': OTHER }));
    await putModels(store, 'owner-1', { defaultModel: 'reasoner' });
    const reasoned = await runWithOwner('owner-1', () => selection.resolve('ghost-agent'));
    expect(reasoned.modelId).toBe('reasoner');
    expect(reasoned.pricing).toEqual(PRICED);
    await putModels(store, 'owner-1', { defaultModel: 'plain' });
    const plain = await runWithOwner('owner-1', () => selection.resolve('ghost-agent'));
    expect(plain.modelId).toBe('plain');
    expect(plain.pricing).toBeUndefined();
  });

  it('keeps the frozen snapshot after the pricing source changes; new runs pick it up', async () => {
    const captured: ModelSnapshot[] = [];
    const first = await setup(pricingJson({ reasoner: PRICED }), captured);
    await putModels(first.store, 'owner-1', { defaultModel: 'reasoner' });
    const frozen = await runWithOwner('owner-1', () => first.selection.resolve('ghost-agent'));
    expect(frozen.pricing).toEqual(PRICED);
    const second = await setup(pricingJson({ reasoner: OTHER }), captured);
    await putModels(second.store, 'owner-1', { defaultModel: 'reasoner' });
    second.selection.providerFor(frozen);
    expect(captured[0]?.pricing).toEqual(PRICED);
    const fresh = await runWithOwner('owner-1', () => second.selection.resolve('ghost-agent'));
    expect(fresh.pricing).toEqual(OTHER);
  });

  it('freezes the fallback model with its own pricing, and switching drops it to the fallback snapshot', async () => {
    const { selection } = await setup(pricingJson({ 'env-default': PRICED, plain: OTHER }), [], { ...ENV, fallbackModelId: 'plain' });
    const snapshot = await selection.resolve('ghost-agent');
    expect(snapshot.fallback).toEqual({ modelId: 'plain', pricing: OTHER });
    const switched = withFallbackModel({ sessionKey: 's', agentId: 'a', modelSelection: snapshot });
    expect(switched).toBeDefined();
    expect(parseModelSnapshot(switched!)).toMatchObject({ modelId: 'plain', baseUrl: ENV.baseUrl, supportsImages: false, pricing: OTHER });
    expect(parseModelSnapshot(switched!)?.fallback).toBeUndefined();
    expect(withFallbackModel(switched!)).toBeUndefined();
  });

  it('keeps no fallback when none is configured', async () => {
    const { selection } = await setup(pricingJson({ 'env-default': PRICED }));
    const snapshot = await selection.resolve('ghost-agent');
    expect(snapshot.fallback).toBeUndefined();
    expect(withFallbackModel({ sessionKey: 's', agentId: 'a', modelSelection: snapshot })).toBeUndefined();
  });

  it('rejects endpoint drift even with pricing frozen', async () => {
    const { selection } = await setup(pricingJson({ 'env-default': PRICED }));
    const snapshot = await selection.resolve('ghost-agent');
    expect(() => selection.providerFor({ ...snapshot, baseUrl: 'http://other.test/v1' })).toThrowError(ModelSelectionError);
    try {
      selection.providerFor({ ...snapshot, baseUrl: 'http://other.test/v1' });
      expect.unreachable();
    } catch (error) {
      expect(error instanceof ModelSelectionError && error.code).toBe('endpoint-changed');
    }
  });
});
