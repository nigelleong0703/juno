/**
 * H-99: a child started with child_spawn `fast` is frozen on the owner's fast model, else the platform's, else the
 * run's normal model. Only a root-less child row with `fastModel` asks for it; the choice is journaled like the
 * parent's, so a later settings change never moves a running child.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { appSettingsSchema, settingsIdFor } from '@agent-desktop/public-contracts';
import type { Run } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { childSessionKey } from '../../../modules/tasks/childRead.js';
import { createBrain } from '../index.js';
import { backendConfigSchema } from '../../config.js';
import type { ModelEnv } from '../model-catalog.js';
import { createAccountModelSelection, parseModelSnapshot } from '../model-selection.js';
import { sealProviderKey } from '../user-providers.js';

const OWNER = 'owner-a';
const AGENT = 'agent-a';
const CONV = 'conv-a';
const NOW = '2026-10-22T00:00:00.000Z';
const PLATFORM_MAIN: ModelEnv = { modelId: 'platform-main', baseUrl: 'https://main.example/v1', apiKey: 'k', supportsImages: false };
const PLATFORM_FAST: ModelEnv = { modelId: 'platform-small', baseUrl: 'https://fast.example/v1', apiKey: 'k', supportsImages: false };

const settings = appSettingsSchema.parse({
  general: { launchAtLogin: false, language: 'en' },
  appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
  notifications: [],
  yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
  connections: { serverUrl: '', modelProviders: [] },
  privacy: { dataRetentionDays: 90, trainingOptIn: false },
  advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
});

type Models = { defaultModel: string | null; providerId?: string; tiers?: { fast?: { providerId?: string; modelId?: string; effort?: 'low' | 'high' } } };

beforeAll(() => {
  process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
});

async function setModels(store: Store, models: Models): Promise<void> {
  await runWithOwner(OWNER, async () => {
    await store.put('modelProviders', { id: 'mprov-1', ownerId: OWNER, apiKey: sealProviderKey('sk-test'), createdAt: NOW, updatedAt: NOW, kind: 'builtin', name: 'OpenCode Go', providerId: 'opencode-go' });
    await store.put('settings', { ...settings, models, id: settingsIdFor(OWNER) });
  });
}

async function setup(opts: { platformFast: boolean; models: Models }) {
  const store = createMemoryStore();
  await setModels(store, opts.models);
  const selection = createAccountModelSelection({
    store,
    config: backendConfigSchema.parse({}),
    env: PLATFORM_MAIN,
    ...(opts.platformFast ? { systemEnv: PLATFORM_FAST } : {}),
    createProvider: () => ({ async call() { throw new Error('not called'); } }),
  });
  const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: undefined, modelSelection: selection });
  const child = async (runId: string, fast: boolean) => {
    const row: Run & { fastModel?: true } = { id: runId, agentId: AGENT, conversationId: CONV, title: 't', status: 'running', kind: 'background', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: NOW, lastActivityAt: NOW, ...(fast ? { fastModel: true as const } : {}) };
    await store.put('runs', row, { agentId: AGENT, conversationId: CONV, runId });
    return childSessionKey(AGENT, CONV, runId);
  };
  const build = (sessionKey: string, previousContext?: Awaited<ReturnType<typeof brain.buildContext>>) =>
    runWithOwner(OWNER, () => brain.buildContext({ agentId: AGENT, conversationId: CONV, sessionKey, wake: [], ...(previousContext === undefined ? {} : { previousContext }) }));
  return { store, child, build };
}

const CHOSEN: Models = { defaultModel: 'kimi-k3', providerId: 'mprov-1', tiers: { fast: { providerId: 'mprov-1', modelId: 'glm-5.3-flash' } } };
const NO_FAST: Models = { defaultModel: 'kimi-k3', providerId: 'mprov-1' };

describe('child_spawn fast model resolution', () => {
  it('uses the owner\'s own fast model first', async () => {
    const { child, build } = await setup({ platformFast: true, models: CHOSEN });
    expect(parseModelSnapshot(await build(await child('c1', true)))).toMatchObject({ modelId: 'glm-5.3-flash', providerId: 'mprov-1' });
  });

  it('then the platform fast model', async () => {
    const { child, build } = await setup({ platformFast: true, models: NO_FAST });
    expect(parseModelSnapshot(await build(await child('c1', true)))).toMatchObject({ modelId: 'platform-small', baseUrl: PLATFORM_FAST.baseUrl });
  });

  it('then the cheap-marked model of the owner\'s provider, never the agent fallback', async () => {
    const { child, build } = await setup({ platformFast: false, models: NO_FAST });
    expect(parseModelSnapshot(await build(await child('c1', true)))).toMatchObject({ modelId: 'qwen3.8-flash', providerId: 'mprov-1' });
  });

  it('leaves a child without fast, and a root session, on the normal model', async () => {
    const { child, build } = await setup({ platformFast: true, models: CHOSEN });
    expect(parseModelSnapshot(await build(await child('c1', false)))?.modelId).toBe('kimi-k3');
    expect(parseModelSnapshot(await build(AGENT + ':' + CONV))?.modelId).toBe('kimi-k3');
  });

  it('freezes the choice: a settings change or a rebuild never moves a running child', async () => {
    const { store, child, build } = await setup({ platformFast: true, models: CHOSEN });
    const sessionKey = await child('c1', true);
    const first = await build(sessionKey);
    await setModels(store, NO_FAST);
    const rebuilt = await build(sessionKey, first);
    expect(parseModelSnapshot(rebuilt)).toEqual(parseModelSnapshot(first));
    expect(parseModelSnapshot(rebuilt)?.modelId).toBe('glm-5.3-flash');
  });
});
