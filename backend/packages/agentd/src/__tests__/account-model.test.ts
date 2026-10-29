import { createMemoryBlobStore } from '@agent-desktop/db';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { TerminalError } from '@agent-desktop/durable';
import { createMemoryStore } from '@agent-desktop/db';
import { NoopEnqueuer } from '../enqueuer.js';
import { registerModels } from '../routes/models.js';
import type { Store, TranscriptEntry } from '@agent-desktop/contracts';
import type { AssistantTurn } from '@agent-desktop/contracts';
import type { AppSettings } from '@agent-desktop/public-contracts';
import { createBrain } from 'juno-agent/execution/brain/index';
import { backendConfigSchema } from 'juno-agent/execution/config';
import { runWithOwner } from '../owner-scope.js';
import { createModelCatalogLoader, type ModelEnv } from 'juno-agent/execution/brain/model-catalog';
import {
  createAccountModelSelection,
  ModelSelectionError,
  parseModelSnapshot,
  toTerminalModelError,
  type ModelSnapshot,
} from 'juno-agent/execution/brain/model-selection';
import type { LimitsAwareProvider } from 'juno-agent/execution/brain/model-limits';
import { withTestOwner } from './test-owner.js';
import { testChannels } from './test-app.js';

// Account-wide runtime model choice: one stored default per owner, resolved once per new
// run and frozen on the journaled context. Steering, compaction and later default changes
// never move an in-flight run; other owners are isolated; bad selections fail loudly.

const ENV: ModelEnv = {
  modelId: 'env-default',
  baseUrl: 'http://provider.test/v1',
  apiKey: 'secret-key-xyz',
  supportsImages: false,
};

const UPSTREAM_DOC = {
  data: [
    { id: 'env-default', name: 'Env Default' },
    { id: 'model-new', name: 'New Model', capabilities: { input_modalities: ['text', 'image'] } },
    {
      id: 'model-other',
      name: 'Other Model',
      capabilities: { supports_vision: true, supports_tool_use: true, context_length: 128000 },
    },
    { id: 'model-new', name: 'New Model Duplicate' },
    { id: 'model-notools', name: 'No Tools', capabilities: { supports_tool_use: false } },
    { id: 'model-embed', name: 'Embed Only', output_modalities: ['embeddings'] },
    { name: 'Missing Id' },
  ],
};

function settingsRow(defaultModel: string | null): AppSettings {
  return {
    general: { launchAtLogin: false, language: 'en' },
    appearance: { theme: 'system', density: 'comfortable', accent: '#0066cc' },
    notifications: [],
    yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
    connections: { serverUrl: 'http://localhost:8787', modelProviders: [] },
    privacy: { dataRetentionDays: 90, trainingOptIn: false },
    advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
    models: { defaultModel },
  };
}


interface SeenCall {
  modelId: string;
  toolCount: number;
}

function stubTurn(): AssistantTurn {
  return {
    text: 'summary-text',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    stopReason: 'stop',
  };
}

function stubProviderFor(snapshot: ModelSnapshot, seen: SeenCall[]): LimitsAwareProvider {
  return {
    async getLimits() {
      return { contextWindow: 8000, maxOutputTokens: 500 };
    },
    async call(options) {
      seen.push({ modelId: snapshot.modelId, toolCount: options.tools.length });
      return stubTurn();
    },
  };
}

interface Fixture {
  store: Store;
  brain: Awaited<ReturnType<typeof createBrain>>;
  seen: SeenCall[];
  bootstrapSeen: SeenCall[];
  resolveCount: () => number;
  fetchCount: () => number;
  authHeader: () => string | null;
  setDefault: (ownerId: string, defaultModel: string | null) => Promise<void>;
}

async function setup(fetchImpl?: typeof fetch): Promise<Fixture> {
  const store = createMemoryStore();
  const seen: SeenCall[] = [];
  const bootstrapSeen: SeenCall[] = [];
  let resolves = 0;
  let fetches = 0;
  let auth: string | null = null;
  const fetchFn: typeof fetch =
    fetchImpl ??
    (async (url, init) => {
      fetches += 1;
      auth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify(UPSTREAM_DOC), { headers: { 'content-type': 'application/json' } });
    });
  const catalog = createModelCatalogLoader(ENV, fetchFn);
  const inner = createAccountModelSelection({
    store,
    config: backendConfigSchema.parse({}),
    env: ENV,
    catalog,
    createProvider: (snapshot) => stubProviderFor(snapshot, seen),
  });
  const selection = {
    resolve: async (agentId: string) => {
      resolves += 1;
      return inner.resolve(agentId);
    },
    providerFor: (snapshot: ModelSnapshot) => inner.providerFor(snapshot),
  };
  const bootstrap: LimitsAwareProvider = {
    async getLimits() {
      return {};
    },
    async call(options) {
      bootstrapSeen.push({ modelId: 'bootstrap', toolCount: options.tools.length });
      return stubTurn();
    },
  };
  const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: bootstrap, modelSelection: selection });
  return {
    store,
    brain,
    seen,
    bootstrapSeen,
    resolveCount: () => resolves,
    fetchCount: () => fetches,
    authHeader: () => auth,
    setDefault: async (ownerId: string, defaultModel: string | null) => {
      await store.put('settings', { id: 'app-settings-' + ownerId, ...settingsRow(defaultModel) });
    },
  };
}

function buildFor(fixture: Fixture, ownerId: string, agentId: string, conversationId: string) {
  return runWithOwner(ownerId, () =>
    fixture.brain.buildContext({
      agentId,
      conversationId,
      sessionKey: agentId + ':' + conversationId,
      wake: [],
    }),
  );
}

async function seedTranscript(store: Store, sessionKey: string, count: number): Promise<void> {
  for (let seq = 0; seq < count; seq += 1) {
    const entry: TranscriptEntry = {
      id: 'tx-seed-' + String(seq),
      sessionKey,
      seq,
      message: { role: 'user', content: 'seed history line ' + String(seq) + ' ' + 'x'.repeat(4000), timestamp: Date.now() },
      compactionEpoch: 0,
      at: new Date().toISOString(),
    };
    await store.put('transcripts', entry);
  }
}

describe('account model selection', () => {
  it('a new default applies to every agent of the same owner on new runs', async () => {
    const fixture = await setup();
    await fixture.setDefault('owner-1', 'model-new');
    const first = await buildFor(fixture, 'owner-1', 'a1', 'c1');
    const second = await buildFor(fixture, 'owner-1', 'a2', 'c2');
    expect(parseModelSnapshot(first)).toEqual({ modelId: 'model-new', baseUrl: ENV.baseUrl, supportsImages: true, controls: { omitReasoning: true } });
    expect(parseModelSnapshot(second)?.modelId).toBe('model-new');
    await fixture.brain.step(first, [], { signal: new AbortController().signal });
    await fixture.brain.step(second, [], { signal: new AbortController().signal });
    expect(fixture.seen.filter((call) => call.modelId === 'model-new')).toHaveLength(2);
    expect(fixture.bootstrapSeen).toHaveLength(0);
  });

  it('other owners are isolated from the default', async () => {
    const fixture = await setup();
    await fixture.setDefault('owner-1', 'model-new');
    await fixture.setDefault('owner-2', 'model-other');
    const own = await buildFor(fixture, 'owner-1', 'a1', 'c1');
    const other = await buildFor(fixture, 'owner-2', 'b1', 'c1');
    expect(parseModelSnapshot(own)?.modelId).toBe('model-new');
    expect(parseModelSnapshot(other)?.modelId).toBe('model-other');
    const stranger = await buildFor(fixture, 'owner-9', 'z1', 'c1');
    expect(parseModelSnapshot(stranger)).toEqual({ modelId: ENV.modelId, baseUrl: ENV.baseUrl, supportsImages: false, controls: { omitReasoning: true } });
  });

  it('a null reset falls back to the env default', async () => {
    const fixture = await setup();
    await fixture.setDefault('owner-1', 'model-new');
    expect(parseModelSnapshot(await buildFor(fixture, 'owner-1', 'a1', 'c1'))?.modelId).toBe('model-new');
    await fixture.setDefault('owner-1', null);
    expect(parseModelSnapshot(await buildFor(fixture, 'owner-1', 'a1', 'c1'))?.modelId).toBe(ENV.modelId);
  });

  it('a frozen step and compact keep running the old default after it changes', async () => {
    const fixture = await setup();
    await fixture.setDefault('owner-1', 'model-new');
    const frozen = await buildFor(fixture, 'owner-1', 'a1', 'c1');
    expect(fixture.resolveCount()).toBe(1);
    await fixture.setDefault('owner-1', 'model-other');
    await seedTranscript(fixture.store, 'a1:c1', 10);
    await fixture.brain.step(frozen, [], { signal: new AbortController().signal });
    expect(fixture.resolveCount()).toBe(1);
    const compacted = await fixture.brain.compact(frozen);
    expect(parseModelSnapshot(compacted)?.modelId).toBe('model-new');
    expect(compacted.compactionEpoch).toBe(1);
    expect(fixture.seen.length).toBeGreaterThan(0);
    for (const call of fixture.seen) expect(call.modelId).toBe('model-new');
    expect(fixture.bootstrapSeen).toHaveLength(0);
  });

  it('a steering rebuild retains the snapshot and the original limits', async () => {
    const fixture = await setup();
    await fixture.setDefault('owner-1', 'model-new');
    const first = await buildFor(fixture, 'owner-1', 'a1', 'c1');
    expect(first['contextWindow']).toBe(8000);
    expect(first['maxOutputTokens']).toBe(500);
    await fixture.setDefault('owner-1', 'model-other');
    const rebuilt = await runWithOwner('owner-1', () =>
      fixture.brain.buildContext({
        agentId: 'a1',
        conversationId: 'c1',
        sessionKey: 'a1:c1',
        wake: [],
        previousContext: first,
      }),
    );
    expect(parseModelSnapshot(rebuilt)).toEqual(parseModelSnapshot(first));
    expect(rebuilt['contextWindow']).toBe(8000);
    expect(rebuilt['maxOutputTokens']).toBe(500);
    expect(fixture.resolveCount()).toBe(1);
  });

  it('an unknown selected model fails instead of silently falling back', async () => {
    const fixture = await setup();
    await fixture.setDefault('owner-1', 'model-nope');
    const failure: unknown = await buildFor(fixture, 'owner-1', 'a1', 'c1').then(
      () => null,
      (error: unknown) => error,
    );
    if (!(failure instanceof ModelSelectionError)) throw new Error('expected a ModelSelectionError');
    expect(failure.code).toBe('unknown-model');
    expect(toTerminalModelError(failure)).toBeInstanceOf(TerminalError);
  });

  it('a present but invalid stored default fails explicitly', async () => {
    const fixture = await setup();
    const corrupt = JSON.parse(JSON.stringify({ id: 'app-settings-owner-1', models: { defaultModel: 42 } }));
    await fixture.store.put('settings', corrupt);
    const failure: unknown = await buildFor(fixture, 'owner-1', 'a1', 'c1').then(
      () => null,
      (error: unknown) => error,
    );
    if (!(failure instanceof ModelSelectionError)) throw new Error('expected a ModelSelectionError');
    expect(failure.code).toBe('invalid-model');
  });

  it('a malformed journaled snapshot is terminal, only a missing one falls back', async () => {
    expect(parseModelSnapshot({ sessionKey: 'a:c', agentId: 'a' })).toBeUndefined();
    const failure: unknown = (() => {
      try {
        parseModelSnapshot({ sessionKey: 'a:c', agentId: 'a', modelSelection: { modelId: 42 } });
        return null;
      } catch (error: unknown) {
        return error;
      }
    })();
    if (!(failure instanceof ModelSelectionError)) throw new Error('expected a ModelSelectionError');
    expect(failure.code).toBe('invalid-snapshot');
    expect(toTerminalModelError(failure)).toBeInstanceOf(TerminalError);
    expect(toTerminalModelError(new Error('boom'))).toBeNull();
  });

  it('the catalog reports published vision, hides unsupported models and redacts keys', async () => {
    let seenAuth: string | null = null;
    let fetches = 0;
    const loader = createModelCatalogLoader(ENV, async (url, init) => {
      void url;
      fetches += 1;
      seenAuth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify(UPSTREAM_DOC), { headers: { 'content-type': 'application/json' } });
    });
    const catalog = await loader.load();
    expect(catalog.fresh).toBe(true);
    expect(catalog.catalog.defaultModel).toBe(ENV.modelId);
    const byId = new Map(catalog.catalog.items.map((item) => [item.id, item]));
    expect(byId.get('model-new')?.supportsImages).toBe(true);
    expect(byId.get('model-other')?.supportsImages).toBe(true);
    expect(byId.get(ENV.modelId)?.supportsImages).toBe(false);
    expect(byId.has('model-notools')).toBe(false);
    expect(byId.has('model-embed')).toBe(false);
    expect(catalog.catalog.items.filter((item) => item.id === 'model-new')).toHaveLength(1);
    expect(JSON.stringify(catalog.catalog)).not.toContain('secret-key-xyz');
    expect(seenAuth).toBe('Bearer secret-key-xyz');
    // The short-TTL cache shares one probe across callers instead of refetching per turn.
    await loader.load();
    expect(fetches).toBe(1);
  });

  it('an unreachable upstream falls back to the env default without leaking', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('boom');
    };
    const loader = createModelCatalogLoader(ENV, failing);
    const first = await loader.load();
    expect(first.fresh).toBe(false);
    expect(first.catalog).toEqual({ defaultModel: ENV.modelId, items: [{ id: ENV.modelId, name: ENV.modelId, supportsImages: false }] });
    expect(JSON.stringify(first.catalog)).not.toContain('secret-key-xyz');
  });

  it('endpoint drift refuses to redirect a frozen run silently', async () => {
    const fixture = await setup();
    const drift: ModelSnapshot = { modelId: 'model-new', baseUrl: 'http://old.test/v1', supportsImages: false };
    let failure: unknown = null;
    try {
      const selection = createAccountModelSelection({
        store: fixture.store,
        config: backendConfigSchema.parse({}),
        env: ENV,
        catalog: createModelCatalogLoader(ENV),
        createProvider: (snapshot) => stubProviderFor(snapshot, []),
      });
      selection.providerFor(drift);
    } catch (error: unknown) {
      failure = error;
    }
    if (!(failure instanceof ModelSelectionError)) throw new Error('expected a ModelSelectionError');
    expect(failure.code).toBe('endpoint-changed');
    expect(failure.message).not.toContain('http');
    expect(toTerminalModelError(failure)).toBeInstanceOf(TerminalError);
  });

  it('a malformed models section fails, a null section falls back', async () => {
    const fixture = await setup();
    const malformed = JSON.parse(JSON.stringify({ id: 'app-settings-owner-1', models: 'bad' }));
    await fixture.store.put('settings', malformed);
    const failure: unknown = await buildFor(fixture, 'owner-1', 'a1', 'c1').then(
      () => null,
      (error: unknown) => error,
    );
    if (!(failure instanceof ModelSelectionError)) throw new Error('expected a ModelSelectionError');
    expect(failure.code).toBe('invalid-model');
    const nulled = JSON.parse(JSON.stringify({ id: 'app-settings-owner-2', models: null }));
    await fixture.store.put('settings', nulled);
    expect(parseModelSnapshot(await buildFor(fixture, 'owner-2', 'b1', 'c1'))?.modelId).toBe(ENV.modelId);
  });

  it('the models route reports 503 without secrets when upstream is unreachable', async () => {
    const full = createMemoryStore();
    const app = withTestOwner(new Hono());
    registerModels(app, {
      store: full,
      bus: full.eventBus,
      enqueuer: new NoopEnqueuer(full),
      channels: testChannels,
      config: { MODEL_ID: 'env-default', MODEL_BASE_URL: 'http://127.0.0.1:1', MODEL_API_KEY: 'secret-key-xyz' },
    });
    const response = await app.request('/v1/models');
    expect(response.status).toBe(503);
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) throw new Error('expected a JSON body');
    expect(JSON.stringify(body)).not.toContain('secret-key-xyz');
    expect(JSON.stringify(body)).toContain('MODEL_CATALOG_UNAVAILABLE');
  });
});
