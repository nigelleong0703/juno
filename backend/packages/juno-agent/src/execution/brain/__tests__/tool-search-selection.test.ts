/**
 * The run snapshot freezes how the model reaches hidden tools (from the model, once), and the frozen system rules tell it the matching
 * way: search then call by name, or search then run with tool_call.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { appSettingsSchema, settingsIdFor } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { backendConfigSchema } from '../../config.js';
import { buildContext, hydrateContext, slimContext } from '../context.js';
import { findSystemEntry } from '../context-notes.js';
import { assistantMessage, toolMessage } from '../messages.js';
import { appendToTranscript } from '../transcript.js';
import { createAccountModelSelection, type ModelSelection, type ModelSnapshot } from '../model-selection.js';
import { readTranscript } from '../transcript.js';
import { sealProviderKey } from '../user-providers.js';
import { AGENT, seed, wakeFor } from './agent-resources.fixtures.js';

const OWNER = 'owner-a';
const NOW = '2026-10-22T00:00:00.000Z';

beforeAll(() => {
  process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
});

async function snapshotFor(provider: { kind: 'builtin'; providerId: string } | { kind: 'custom'; wire: 'openai-responses' }, defaultModel: string): Promise<ModelSnapshot> {
  const store = createMemoryStore();
  return runWithOwner(OWNER, async () => {
    const base = { id: 'mprov-1', ownerId: OWNER, apiKey: sealProviderKey('sk-test'), createdAt: NOW, updatedAt: NOW };
    await store.put('modelProviders', provider.kind === 'builtin'
      ? { ...base, kind: 'builtin', name: 'Built-in', providerId: provider.providerId }
      : { ...base, kind: 'custom', name: 'Mine', baseUrl: 'https://llm.example/v1', wire: provider.wire });
    await store.put('settings', {
      ...appSettingsSchema.parse({
        general: { launchAtLogin: false, language: 'en' }, appearance: { theme: 'system', density: 'comfortable', accent: 'blue' }, notifications: [],
        yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' }, connections: { serverUrl: '', modelProviders: [] },
        privacy: { dataRetentionDays: 90, trainingOptIn: false }, advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
      }),
      models: { defaultModel, providerId: 'mprov-1' }, id: settingsIdFor(OWNER),
    });
    return createAccountModelSelection({ store, config: backendConfigSchema.parse({ MODEL_PRICING_JSON: '' }) }).resolve('agent-x');
  });
}

describe('tool search mode in the run snapshot', () => {
  it('freezes the native search for a verified or catalog-supported model, and nothing for the rest', async () => {
    expect((await snapshotFor({ kind: 'builtin', providerId: 'opencode-go' }, 'muse-spark-1.3-contributor')).toolSearch).toBe('responses-tool-search');
    expect((await snapshotFor({ kind: 'builtin', providerId: 'openai' }, 'gpt-5.4')).toolSearch).toBe('responses-tool-search');
    expect((await snapshotFor({ kind: 'builtin', providerId: 'opencode-go' }, 'qwen3.8-flash')).toolSearch).toBeUndefined();
    expect((await snapshotFor({ kind: 'custom', wire: 'openai-responses' }, 'muse-spark-1.3-contributor')).toolSearch).toBeUndefined();
  });

  it('freezes it for the platform default only when MODEL_ID names a verified model', async () => {
    const select = (modelId: string) => runWithOwner(OWNER, () => createAccountModelSelection({
      store: createMemoryStore(), config: backendConfigSchema.parse({ MODEL_PRICING_JSON: '', MODEL_WIRE_API: 'responses' }),
      env: { modelId, baseUrl: 'http://127.0.0.1:10100/v1', apiKey: 'k', supportsImages: false },
    }).resolve('agent-x'));
    expect((await select('opencode-go/muse-spark-1.3-contributor')).toolSearch).toBe('responses-tool-search');
    expect((await select('gpt-test')).toolSearch).toBeUndefined();
  });
});

describe('a native search in the transcript', () => {
  it('survives the stored transcript and the context projection with the fields the provider needs', async () => {
    const store = await seed();
    const key = AGENT + ':conv-1';
    const base = { agentId: AGENT, conversationId: 'conv-1', sessionKey: key, wake: [wakeFor(AGENT)] };
    const first = await buildContext(store, { ...base, noteKey: 'ctx0:r1' });
    const call = { type: 'toolCall' as const, id: 'call_ts1', name: 'tool_search', arguments: { query: 'weather' }, nativeSearch: true, itemId: 'ts_1' };
    const turn = { ...assistantMessage({ text: '', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, stopReason: 'stop' }), content: [call], stopReason: 'toolUse' as const };
    await appendToTranscript(store, key, [turn, toolMessage('tool_search', 'call_ts1', { content: [{ type: 'text', text: 'Loaded 1 tool: get_weather.' }], details: { loadedTools: ['get_weather'] } })], 'step-1');
    const rebuilt = await buildContext(store, { ...base, previousContext: first, noteKey: 'ctxN:r1:1' });
    const hydrated = await hydrateContext(store, slimContext(rebuilt));
    expect(JSON.stringify(hydrated.messages.find((message) => message.role === 'assistant')?.content)).toContain('"nativeSearch":true');
    expect(hydrated.messages.find((message) => message.role === 'toolResult')).toMatchObject({ toolCallId: 'call_ts1', loadedTools: ['get_weather'] });
  });
});

describe('the frozen rules follow the mode', () => {
  async function systemText(store: Store, toolSearch: ModelSnapshot['toolSearch']): Promise<string> {
    const snapshot: ModelSnapshot = { modelId: 'm', baseUrl: 'https://x/v1', supportsImages: false, ...(toolSearch === undefined ? {} : { toolSearch }) };
    const modelSelection: ModelSelection = { resolve: async () => snapshot, providerFor: () => ({ call: async () => { throw new Error('not called'); } }) };
    const key = AGENT + ':conv-1';
    await buildContext(store, { agentId: AGENT, conversationId: 'conv-1', sessionKey: key, wake: [wakeFor(AGENT)], modelSelection, noteKey: 'ctx0:r1' });
    const system = findSystemEntry(await readTranscript(store, key));
    return String(system?.message['content']);
  }

  it('tells a native model to search and call by name, and a proxy model to search and run with tool_call', async () => {
    const native = await systemText(await seed(), 'responses-tool-search');
    expect(native).toContain('search with tool_search, then call the tool by its name');
    expect(native).not.toContain('tool_call');
    const proxy = await systemText(await seed(), undefined);
    expect(proxy).toContain('find it with tool_search and run it with tool_call');
  });
});
