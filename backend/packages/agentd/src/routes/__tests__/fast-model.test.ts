/**
 * GET /v1/model-providers/fast-model: the fast model background calls would use for the caller right now,
 * which the API shows under "Auto". Owner-scoped; platform-paid models only count when configured.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import { backendConfigSchema } from 'juno-agent/execution/config';
import { appSettingsSchema } from '@agent-desktop/public-contracts';
import { createTestApp, requestAs } from '../../__tests__/test-app.js';

async function makeApp(config?: Record<string, string>) {
  const mem = createMemoryStore();
  const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer(), ...(config === undefined ? {} : { config: backendConfigSchema.parse(config) }) });
  return { app, store: mem };
}

const baseSettings = appSettingsSchema.parse({
  general: { launchAtLogin: false, language: 'en' },
  appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
  notifications: [],
  yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
  connections: { serverUrl: '', modelProviders: [] },
  privacy: { dataRetentionDays: 90, trainingOptIn: false },
  advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
});

const ask = (app: Awaited<ReturnType<typeof makeApp>>['app'], owner: string) => requestAs(app, owner, '/v1/model-providers/fast-model').then((r) => r.json());

describe('effective fast model route', () => {
  it('answers the cheap model of the caller\'s default provider, and nothing for an owner without one', async () => {
    const { app, store } = await makeApp();
    const mine = store.forOwner!('owner-a');
    const now = new Date().toISOString();
    await mine.put('modelProviders', { id: 'mprov-1', ownerId: 'owner-a', kind: 'builtin', name: 'OpenCode Go', providerId: 'opencode-go', apiKey: 'enc:v1:x', createdAt: now, updatedAt: now });
    await mine.put('settings', { ...baseSettings, id: 'app-settings-owner-a', models: { defaultModel: 'kimi-k3', providerId: 'mprov-1' } });
    expect(await ask(app, 'owner-a')).toEqual({ providerId: 'mprov-1', modelId: 'qwen3.8-flash', source: 'cheap' });
    expect(await ask(app, 'owner-b')).toBeNull();
  });

  it('prefers the platform fast model when configured, else reports the platform main model as the agent model', async () => {
    const platform = { MODEL_BASE_URL: 'https://m.example/v1', MODEL_ID: 'big', MODEL_API_KEY: 'k' };
    const main = await makeApp(platform);
    expect(await ask(main.app, 'owner-a')).toEqual({ providerId: null, modelId: 'big', source: 'agent' });
    const both = await makeApp({ ...platform, FAST_MODEL_ID: 'small' });
    expect(await ask(both.app, 'owner-a')).toEqual({ providerId: null, modelId: 'small', source: 'platform' });
  });
});

describe('effective tiers route', () => {
  it('answers each tier from the owner\'s rows over the main model, and null rows for an owner with no model', async () => {
    const { app, store } = await makeApp();
    const mine = store.forOwner!('owner-a');
    const now = new Date().toISOString();
    await mine.put('modelProviders', { id: 'mprov-1', ownerId: 'owner-a', kind: 'builtin', name: 'OpenCode Go', providerId: 'opencode-go', apiKey: 'enc:v1:x', createdAt: now, updatedAt: now });
    await mine.put('settings', { ...baseSettings, id: 'app-settings-owner-a', models: { defaultModel: 'kimi-k3', providerId: 'mprov-1', tiers: { deep: { effort: 'max' }, fast: { providerId: 'mprov-1', modelId: 'glm-5.3-flash' } } } });
    const tiers = await requestAs(app, 'owner-a', '/v1/model-providers/tiers').then((r) => r.json()) as Record<string, { modelId: string; effort: string | null; source: string }>;
    expect(tiers['deep']).toMatchObject({ modelId: 'kimi-k3', effort: 'max', source: 'chosen' });
    expect(tiers['chat']).toMatchObject({ modelId: 'kimi-k3', source: 'default' });
    expect(tiers['fast']).toMatchObject({ modelId: 'glm-5.3-flash', source: 'chosen' });
    expect(await requestAs(app, 'owner-b', '/v1/model-providers/tiers').then((r) => r.json())).toEqual({ chat: null, task: null, deep: null, fast: null });
  });
});

describe('effective System One route', () => {
  const askOne = (app: Awaited<ReturnType<typeof makeApp>>['app']) => requestAs(app, 'owner-a', '/v1/model-providers/system-one').then((r) => r.json());

  it('answers the platform endpoint when configured, else the fast model emulating one, else null', async () => {
    const main = { MODEL_BASE_URL: 'https://m.example/v1', MODEL_ID: 'big', MODEL_API_KEY: 'k' };
    expect(await askOne((await makeApp(main)).app)).toEqual({ providerId: null, modelId: 'big', source: 'fast-model-emulation' });
    expect(await askOne((await makeApp()).app)).toBeNull();
    const platform = await makeApp({ ...main, SYSTEM_ONE_BASE_URL: 'https://api.typesafe.ai', SYSTEM_ONE_API_KEY: 'k' });
    expect(await askOne(platform.app)).toEqual({ providerId: null, modelId: 'jev-latest', source: 'platform' });
  });
});
