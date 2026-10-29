/**
 * The fast model resolver (BACKEND §10.14): the owner's choice, then the platform's fast model, then the
 * cheap-marked model of the owner's default provider, then their agent model. Each step falls through when it
 * cannot produce a model. The brain's background calls run on the resolved model.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { appSettingsSchema, settingsIdFor } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { createBrain } from '../index.js';
import { backendConfigSchema } from '../../config.js';
import { createAccountModelSelection, type ModelSnapshot } from '../model-selection.js';
import { readFastModelEnv, resolveFastModel } from '../fast-model.js';
import { sealProviderKey } from '../user-providers.js';

const OWNER = 'owner-a';
const PLATFORM: ModelSnapshot = { modelId: 'platform-small', baseUrl: 'https://platform.example/v1', supportsImages: false };
const NOW = '2026-10-15T00:00:00.000Z';

type Models = { defaultModel: string | null; providerId?: string; tiers?: { fast?: { providerId?: string; modelId?: string; effort?: 'low' | 'high' } } };

const baseSettings = appSettingsSchema.parse({
  general: { launchAtLogin: false, language: 'en' },
  appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
  notifications: [],
  yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
  connections: { serverUrl: '', modelProviders: [] },
  privacy: { dataRetentionDays: 90, trainingOptIn: false },
  advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
});

/** An owner with one built-in (or custom) provider and the given model settings. */
async function seed(store: Store, models: Models, provider: 'opencode-go' | 'custom' | 'chatgpt' | 'none' = 'opencode-go'): Promise<void> {
  await runWithOwner(OWNER, async () => {
    const base = { id: 'mprov-1', ownerId: OWNER, apiKey: sealProviderKey('sk-test'), createdAt: NOW, updatedAt: NOW };
    if (provider === 'opencode-go') await store.put('modelProviders', { ...base, kind: 'builtin', name: 'OpenCode Go', providerId: 'opencode-go' });
    if (provider === 'chatgpt') await store.put('modelProviders', { ...base, kind: 'builtin', name: 'OpenAI', providerId: 'openai', auth: 'chatgpt' });
    if (provider === 'custom') await store.put('modelProviders', { ...base, kind: 'custom', name: 'Mine', baseUrl: 'https://llm.example/v1', wire: 'openai-completions' });
    await store.put('settings', { ...baseSettings, models, id: settingsIdFor(OWNER) });
  });
}

const resolve = (store: Store, platform?: ModelSnapshot) => runWithOwner(OWNER, () => resolveFastModel(store, OWNER, platform, 'standard'));

beforeAll(() => {
  process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
});

describe('resolveFastModel order', () => {
  it('uses the owner\'s chosen fast model over everything else', async () => {
    const store = createMemoryStore();
    await seed(store, { defaultModel: 'kimi-k3', providerId: 'mprov-1', tiers: { fast: { providerId: 'mprov-1', modelId: 'glm-5.3-flash' } } });
    const picked = await resolve(store, PLATFORM);
    expect(picked?.source).toBe('chosen');
    expect(picked?.snapshot).toMatchObject({ modelId: 'glm-5.3-flash', providerId: 'mprov-1' });
  });

  it('falls to the platform fast model when the choice is unusable (provider gone, model unknown) or unset', async () => {
    const store = createMemoryStore();
    await seed(store, { defaultModel: 'kimi-k3', providerId: 'mprov-1', tiers: { fast: { providerId: 'mprov-gone', modelId: 'glm-5.3-flash' } } });
    expect((await resolve(store, PLATFORM))?.source).toBe('platform');
    await seed(store, { defaultModel: 'kimi-k3', providerId: 'mprov-1', tiers: { fast: { providerId: 'mprov-1', modelId: 'no-such-model' } } });
    expect((await resolve(store, PLATFORM))?.snapshot).toEqual(PLATFORM);
    await seed(store, { defaultModel: 'kimi-k3', providerId: 'mprov-1' });
    expect((await resolve(store, PLATFORM))?.source).toBe('platform');
  });

  it('without a platform model takes the cheap-marked model of the owner\'s default provider', async () => {
    const store = createMemoryStore();
    await seed(store, { defaultModel: 'kimi-k3', providerId: 'mprov-1' });
    const picked = await resolve(store);
    expect(picked?.source).toBe('cheap');
    expect(picked?.snapshot.modelId).toBe('qwen3.8-flash');
  });

  it('falls to the agent model when the provider marks no cheap model (custom endpoint, ChatGPT sign-in)', async () => {
    const custom = createMemoryStore();
    await seed(custom, { defaultModel: 'my-model', providerId: 'mprov-1' }, 'custom');
    expect(await resolve(custom)).toMatchObject({ source: 'agent', snapshot: { modelId: 'my-model' } });
    const chatgpt = createMemoryStore();
    await seed(chatgpt, { defaultModel: 'gpt-5.5', providerId: 'mprov-1' }, 'chatgpt');
    expect(await resolve(chatgpt)).toMatchObject({ source: 'agent', snapshot: { modelId: 'gpt-5.5' } });
  });

  it('is undefined with no provider chosen and no platform model', async () => {
    const store = createMemoryStore();
    await seed(store, { defaultModel: null }, 'none');
    expect(await resolve(store)).toBeUndefined();
  });
});

describe('the platform fast model env', () => {
  it('applies only when FAST_MODEL_ID is set, reusing the main endpoint for blank values', () => {
    expect(readFastModelEnv({ MODEL_BASE_URL: 'https://m/v1', MODEL_API_KEY: 'k' })).toBeUndefined();
    expect(readFastModelEnv({ FAST_MODEL_ID: 'small', MODEL_BASE_URL: 'https://m/v1', MODEL_API_KEY: 'k' })).toMatchObject({ modelId: 'small', baseUrl: 'https://m/v1', apiKey: 'k' });
    expect(readFastModelEnv({ FAST_MODEL_ID: 'small', FAST_MODEL_BASE_URL: 'https://s/v1', FAST_MODEL_API_KEY: 'sk', MODEL_BASE_URL: 'https://m/v1' })).toMatchObject({ baseUrl: 'https://s/v1', apiKey: 'sk' });
    expect(readFastModelEnv({ FAST_MODEL_ID: 'small' })).toBeUndefined();
  });
});

describe('brain background calls', () => {
  const reply = { text: 'ok', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };

  it('quickText and completeText run on the fast model, not the platform main model; completeText reports which', async () => {
    const store = createMemoryStore();
    await seed(store, { defaultModel: 'kimi-k3', providerId: 'mprov-1' });
    const main = vi.fn(async () => reply);
    const system = vi.fn(async () => reply);
    const selection = { ...createAccountModelSelection({ store, config: backendConfigSchema.parse({}) }), providerFor: () => ({ call: system }) };
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: { call: main } as never, modelSelection: selection as never });
    await runWithOwner(OWNER, async () => {
      expect(await brain.quickText?.('title?')).toBe('ok');
      expect(await brain.completeText?.({ agentId: 'a', sessionKey: 's', system: 'sys', prompt: 'p' })).toMatchObject({ text: 'ok', model: 'qwen3.8-flash' });
    });
    expect(system).toHaveBeenCalledTimes(2);
    expect(main).not.toHaveBeenCalled();
  });

  it('falls back to the platform main model when the owner has no fast model', async () => {
    const store = createMemoryStore();
    await seed(store, { defaultModel: null }, 'none');
    const main = vi.fn(async () => reply);
    const selection = createAccountModelSelection({ store, config: backendConfigSchema.parse({}) });
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: { call: main } as never, modelSelection: selection });
    await runWithOwner(OWNER, async () => {
      expect(await brain.quickText?.('title?')).toBe('ok');
    });
    expect(main).toHaveBeenCalledTimes(1);
  });
});
