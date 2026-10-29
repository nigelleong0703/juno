/**
 * Per-owner model providers. Security: the key is sealed at rest, never in a run snapshot or an error,
 * and read fresh per call; another owner's provider is unreachable. Resolution: with no platform default
 * an owner without a provider fails fast with MODEL_PROVIDER_REQUIRED, and an owner's own provider runs
 * against its own endpoint. Failure: a rejected user key is a typed run failure and never falls back.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { backendConfigSchema } from '../../config.js';
import { appSettingsSchema, settingsIdFor } from '@agent-desktop/public-contracts';
import { createAccountModelSelection, ModelSelectionError, type ModelSnapshot } from '../model-selection.js';
import { openProviderKey, readOwnedProvider, sealProviderKey } from '../user-providers.js';
import { ProviderFailureError } from '../model-failure.js';
import { createUserProvider } from '../user-providers.js';

const OWNER = 'owner-a';
const OTHER = 'owner-b';
const KEY = 'sk-user-key-0001';

interface Upstream { url: string; auth: string[]; status: number; close(): Promise<void> }

/** A fake OpenAI-compatible upstream: /models and streamed chat completions; it records each Authorization. */
async function upstream(status = 200): Promise<Upstream> {
  const auth: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    auth.push(String(req.headers.authorization ?? ''));
    if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] };
      const done = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    auth,
    status,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const settings = (ownerId: string, models: { defaultModel: string | null; providerId?: string }) => ({
  ...appSettingsSchema.parse({
    general: { launchAtLogin: false, language: 'en' },
    appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
    notifications: [],
    yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
    connections: { serverUrl: '', modelProviders: [] },
    privacy: { dataRetentionDays: 90, trainingOptIn: false },
    advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
  }),
  models,
  id: settingsIdFor(ownerId),
});

const config = backendConfigSchema.parse({ MODEL_PRICING_JSON: '' });

async function customProvider(store: Store, ownerId: string, baseUrl: string, id = 'mprov-test'): Promise<void> {
  await runWithOwner(ownerId, async () => {
    await store.put('modelProviders', {
      id,
      ownerId,
      kind: 'custom',
      name: 'My endpoint',
      baseUrl,
      wire: 'openai-completions',
      apiKey: sealProviderKey(KEY),
      createdAt: '2026-10-13T00:00:00.000Z',
      updatedAt: '2026-10-13T00:00:00.000Z',
    });
    await store.put('settings', settings(ownerId, { defaultModel: 'fake-model', providerId: id }));
  });
}

function selectionFor(store: Store) {
  return createAccountModelSelection({ store, config });
}

async function callOnce(provider: ReturnType<typeof createUserProvider>) {
  return provider.call({
    messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    tools: [],
    signal: AbortSignal.timeout(10_000),
  });
}

beforeAll(() => {
  process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
  process.env['MCP_ALLOW_PRIVATE_HOSTS'] = '1';
});

afterAll(() => {
  delete process.env['MCP_ALLOW_PRIVATE_HOSTS'];
});

describe('owner model providers without a platform default', () => {
  it('fails fast with MODEL_PROVIDER_REQUIRED when the owner has no provider', async () => {
    const store = createMemoryStore();
    await runWithOwner(OWNER, async () => {
      await store.put('settings', settings(OWNER, { defaultModel: null }));
      const error = await selectionFor(store).resolve('agent-x').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelSelectionError);
      expect((error as ModelSelectionError).code).toBe('MODEL_PROVIDER_REQUIRED');
    });
  });

  it('runs an owner provider against its own endpoint, reading the key per call', async () => {
    const server = await upstream();
    try {
      const store = createMemoryStore();
      await customProvider(store, OWNER, server.url);
      await runWithOwner(OWNER, async () => {
        const selection = selectionFor(store);
        const snapshot = await selection.resolve('agent-x');
        expect(snapshot.providerId).toBe('mprov-test');
        expect(snapshot.baseUrl).toBe(server.url);
        expect(snapshot.fallback).toBeUndefined();
        expect(JSON.stringify(snapshot)).not.toContain(KEY);

        const provider = selection.providerFor(snapshot);
        await callOnce(provider as ReturnType<typeof createUserProvider>);
        expect(server.auth.at(-1)).toBe('Bearer ' + KEY);

        // Rotating the key takes effect on the next call without a new run.
        await runWithOwner(OWNER, () => store.patch('modelProviders', 'mprov-test', { apiKey: sealProviderKey('sk-rotated-0002') }));
        await callOnce(provider as ReturnType<typeof createUserProvider>);
        expect(server.auth.at(-1)).toBe('Bearer sk-rotated-0002');
      });
    } finally {
      await server.close();
    }
  });

  it('refuses a call when the owner provider endpoint no longer matches the run', async () => {
    const server = await upstream();
    try {
      const store = createMemoryStore();
      await customProvider(store, OWNER, server.url);
      await runWithOwner(OWNER, async () => {
        const selection = selectionFor(store);
        const snapshot = await selection.resolve('agent-x');
        await runWithOwner(OWNER, () => store.patch('modelProviders', 'mprov-test', { baseUrl: 'http://127.0.0.1:9/v1' }));
        const error = await callOnce(selection.providerFor(snapshot) as ReturnType<typeof createUserProvider>).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ModelSelectionError);
        expect((error as ModelSelectionError).code).toBe('endpoint-changed');
        expect(server.auth).toHaveLength(0);
      });
    } finally {
      await server.close();
    }
  });

  it('a rejected user key is a typed run failure that names the key and never falls back', async () => {
    const server = await upstream(401);
    try {
      const store = createMemoryStore();
      await customProvider(store, OWNER, server.url);
      await runWithOwner(OWNER, async () => {
        const selection = selectionFor(store);
        const snapshot: ModelSnapshot = await selection.resolve('agent-x');
        const error = await callOnce(selection.providerFor(snapshot) as ReturnType<typeof createUserProvider>).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ProviderFailureError);
        const failure = (error as ProviderFailureError).failure;
        expect(failure.kind).toBe('auth');
        expect(failure.message).toContain('API key');
        expect(failure.message).not.toContain(KEY);
        expect(snapshot.fallback).toBeUndefined();
      });
    } finally {
      await server.close();
    }
  });
});

describe('owner provider storage and isolation', () => {
  it('keeps the key sealed at rest and round-trips it only through the sealed form', async () => {
    const store = createMemoryStore();
    await customProvider(store, OWNER, 'http://provider.test/v1');
    await runWithOwner(OWNER, async () => {
      const doc = await readOwnedProvider(store, OWNER, 'mprov-test');
      expect(doc?.apiKey.startsWith('enc:v1:')).toBe(true);
      expect(doc?.apiKey).not.toContain(KEY);
      expect(openProviderKey(doc?.apiKey ?? '')).toBe(KEY);
    });
  });

  it('never resolves another owner\'s provider', async () => {
    const store = createMemoryStore();
    await customProvider(store, OWNER, 'http://provider.test/v1');
    await runWithOwner(OTHER, async () => {
      await store.put('settings', settings(OTHER, { defaultModel: 'fake-model', providerId: 'mprov-test' }));
      expect(await readOwnedProvider(store, OTHER, 'mprov-test')).toBeUndefined();
      // A foreign (or deleted) provider id counts as none chosen: with no platform default nothing can run.
      const error = await selectionFor(store).resolve('agent-y').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelSelectionError);
      expect((error as ModelSelectionError).code).toBe('MODEL_PROVIDER_REQUIRED');
    });
  });
});
