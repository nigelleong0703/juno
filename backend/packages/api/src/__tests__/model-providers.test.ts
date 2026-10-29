/**
 * Owner model providers over HTTP. Security: a key is write-only (never in any response body), sealed at
 * rest, and a custom endpoint on a private host is refused at save time. Isolation: another owner's
 * provider answers 404 and is absent from their list. `usable` tells the client whether a run can start.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { createApiApp, type ApiAuth } from '../server.js';
import type { ModelCatalogLoader } from '../modules/settings.js';
import type { ModelProviderCatalogClient } from '../modules/model-providers.js';

const A = 'owner-a';
const B = 'owner-b';
const KEY = 'sk-live-super-secret-7788';

function testAuth(): ApiAuth {
  const owners: Record<string, string> = { 'sess-a': A, 'sess-b': B };
  return {
    info: { mode: 'account', providers: ['credential'] },
    handle: async () => new Response('auth', { status: 200 }),
    resolve: async (request) => {
      const header = request.headers.get('authorization');
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
      const ownerId = token ? owners[token] : undefined;
      return ownerId ? { ownerId } : null;
    },
  };
}

const chosen: string[] = [];
const providerClient: ModelProviderCatalogClient = {
  async modelChosen(ownerId, providerId) {
    chosen.push(ownerId + ':' + providerId);
  },
  async builtinProviders() {
    return [{ id: 'openai', name: 'OpenAI', authKinds: ['api_key'], modelCount: 2 }];
  },
  async providerModels() {
    return { kind: 'ok', catalog: { defaultModel: 'gpt-x', items: [{ id: 'gpt-x', name: 'GPT X', supportsImages: false }] } };
  },
  async effectiveTiers() {
    return null;
  },
  async effectiveSystemOneModel() {
    return null;
  },
};

const noModels: ModelCatalogLoader = async () => ({ defaultModel: 'env', items: [{ id: 'env', name: 'env', supportsImages: false }] });

/** The owner-scoped view a test reads through (the store's own forOwner, as the app does). */
function ownerView(store: Store, ownerId: string): Store {
  if (store.forOwner === undefined) throw new Error('store must support forOwner');
  return store.forOwner(ownerId);
}

function build(store: Store) {
  const app = createApiApp({
    auth: testAuth(),
    agentdUrl: 'http://127.0.0.1:8788',
    internalToken: 'service-token',
    fetch: async () => Response.json({ items: [] }),
    store, blobs: createMemoryBlobStore(),
    modelsLoader: noModels,
    providerClient,
    platformDefault: false,
  });
  return (path: string, session: string, init: { method?: string; body?: unknown } = {}) =>
    Promise.resolve(app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: 'Bearer ' + session,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }));
}

describe('owner model providers over HTTP', () => {
  it('stores the key write-only and sealed: no response carries it', async () => {
    process.env['SECRETS_KEY'] = Buffer.alloc(32, 7).toString('base64');
    const store = createMemoryStore();
    const call = build(store);

    const created = await call('/v1/model-providers', 'sess-a', { method: 'POST', body: { kind: 'builtin', providerId: 'openai', apiKey: KEY } });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { id: string; hasKey: boolean };
    expect(createdBody.hasKey).toBe(true);

    const listed = await call('/v1/model-providers', 'sess-a');
    const text = await listed.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('enc:v1:');

    const row = await ownerView(store, A).get('modelProviders', createdBody.id);
    expect(row?.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(row?.apiKey).not.toContain(KEY);
  });

  it('a saved provider is not usable until its model is chosen; choosing it tells agentd once per save', async () => {
    process.env['SECRETS_KEY'] = Buffer.alloc(32, 7).toString('base64');
    const call = build(createMemoryStore());
    chosen.length = 0;
    const created = await (await call('/v1/model-providers', 'sess-a', { method: 'POST', body: { kind: 'builtin', providerId: 'openai', apiKey: KEY } })).json() as { id: string };
    const usable = async () => ((await (await call('/v1/model-providers', 'sess-a')).json()) as { usable: boolean }).usable;
    expect(await usable()).toBe(false);
    expect(chosen).toEqual([]);
    await call('/v1/settings', 'sess-a', { method: 'PATCH', body: { models: { providerId: created.id, defaultModel: 'gpt-x' } } });
    expect(await usable()).toBe(true);
    expect(chosen).toEqual([A + ':' + created.id]);
  });

  it('refuses another owner\'s provider with 404 and never lists it', async () => {
    process.env['SECRETS_KEY'] = Buffer.alloc(32, 7).toString('base64');
    const store = createMemoryStore();
    const call = build(store);
    const created = await call('/v1/model-providers', 'sess-a', { method: 'POST', body: { kind: 'builtin', providerId: 'openai', apiKey: KEY } });
    const id = ((await created.json()) as { id: string }).id;

    const listedB = await (await call('/v1/model-providers', 'sess-b')).json() as { providers: unknown[]; usable: boolean };
    expect(listedB.providers).toHaveLength(0);
    expect(listedB.usable).toBe(false);

    expect((await call('/v1/model-providers/' + id, 'sess-b', { method: 'PATCH', body: { apiKey: 'sk-other-000001' } })).status).toBe(404);
    expect((await call('/v1/model-providers/' + id, 'sess-b', { method: 'DELETE' })).status).toBe(404);
    // The owner's key is untouched by the other owner's attempt.
    expect((await ownerView(store, A).get('modelProviders', id))?.apiKey.length).toBeGreaterThan(0);
  });

  it('refuses a custom endpoint on a private host at save time', async () => {
    process.env['SECRETS_KEY'] = Buffer.alloc(32, 7).toString('base64');
    const call = build(createMemoryStore());
    const response = await call('/v1/model-providers', 'sess-a', {
      method: 'POST',
      body: { kind: 'custom', name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', wire: 'openai-completions', apiKey: KEY },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('MODEL_URL_BLOCKED');
  });
});
