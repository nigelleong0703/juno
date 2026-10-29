/** The run snapshot freezes whether the provider's own web search replaces Juno's: model capability plus the owner's webSearch setting. */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { appSettingsSchema, settingsIdFor, type WebSearchMode } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { backendConfigSchema } from '../../config.js';
import { createAccountModelSelection } from '../model-selection.js';
import { sealProviderKey } from '../user-providers.js';

const OWNER = 'owner-a';

beforeAll(() => {
  process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
});

async function snapshotFor(baseUrl: string, wire: 'openai-responses' | 'openai-completions', webSearch?: WebSearchMode) {
  const store = createMemoryStore();
  return runWithOwner(OWNER, async () => {
    await store.put('modelProviders', {
      id: 'mprov-test', ownerId: OWNER, kind: 'custom', name: 'Mine', baseUrl, wire,
      apiKey: sealProviderKey('sk-user-key-0001'), createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
    });
    await store.put('settings', {
      ...appSettingsSchema.parse({
        general: { launchAtLogin: false, language: 'en' },
        appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
        notifications: [],
        yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
        connections: { serverUrl: '', modelProviders: [] },
        privacy: { dataRetentionDays: 90, trainingOptIn: false },
        advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
      }),
      models: { defaultModel: 'gpt-test', providerId: 'mprov-test', ...(webSearch === undefined ? {} : { webSearch }) },
      id: settingsIdFor(OWNER),
    });
    return createAccountModelSelection({ store, config: backendConfigSchema.parse({ MODEL_PRICING_JSON: '' }) }).resolve('agent-x');
  });
}

describe('native web search in the run snapshot', () => {
  it('auto (and unset) freezes the provider search for the vendor endpoint', async () => {
    expect((await snapshotFor('https://api.openai.com/v1', 'openai-responses')).nativeWebSearch).toBe(true);
    expect((await snapshotFor('https://api.openai.com/v1', 'openai-responses', 'auto')).nativeWebSearch).toBe(true);
  });

  it('juno keeps Juno search even where the model has its own', async () => {
    expect((await snapshotFor('https://api.openai.com/v1', 'openai-responses', 'juno')).nativeWebSearch).toBeUndefined();
  });

  it('a proxy or a wire without the tool keeps Juno search', async () => {
    expect((await snapshotFor('https://proxy.example.com/v1', 'openai-responses')).nativeWebSearch).toBeUndefined();
    expect((await snapshotFor('https://api.openai.com/v1', 'openai-completions')).nativeWebSearch).toBeUndefined();
  });
});
