/**
 * The account's System One setting (BACKEND §10.14): it must name one of the caller's own `systemone` providers and one of
 * the model ids that provider lists; a System One provider is not a chat provider; settings answer with the resolved model.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import { appSettingsResponseSchema } from '@agent-desktop/public-contracts';
import { createApiApp, type ApiAuth } from '../server.js';
import type { ModelProviderCatalogClient } from '../modules/model-providers.js';

const auth: ApiAuth = {
  info: { mode: 'account', providers: ['credential'] },
  handle: async () => new Response('auth', { status: 200 }),
  resolve: async (request) => {
    const owner = request.headers.get('authorization')?.slice('Bearer '.length);
    return owner === undefined ? null : { ownerId: owner };
  },
};

const providerClient: ModelProviderCatalogClient = {
  async builtinProviders() {
    return [];
  },
  async providerModels() {
    return { kind: 'ok', catalog: { defaultModel: 'big-1', items: [{ id: 'big-1', name: 'Big', supportsImages: false }] } };
  },
  async effectiveTiers() {
    return null;
  },
  async effectiveSystemOneModel() {
    return { providerId: 'p', modelId: 'jev-latest', source: 'chosen' };
  },
};

function build() {
  process.env['SECRETS_KEY'] = Buffer.alloc(32, 9).toString('base64');
  const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: async () => Response.json({}), store: createMemoryStore(), blobs: createMemoryBlobStore(), providerClient, platformDefault: false });
  return (owner: string, method: string, path: string, body?: unknown) => Promise.resolve(app.request(path, {
    method,
    headers: { Authorization: 'Bearer ' + owner, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

const jev = { kind: 'systemone', name: 'Jev', baseUrl: 'https://api.typesafe.ai', models: ['jev-latest', 'jev-1.13'], apiKey: 'ts-secret-key' };

describe('settings.models.systemOneModel', () => {
  it('accepts only the caller\'s own System One provider and one of its listed models, and a System One provider is no chat provider', async () => {
    const call = build();
    const created = await (await call('a', 'POST', '/v1/model-providers', jev)).json() as { id: string; kind: string; models: string[] };
    expect(created).toMatchObject({ kind: 'systemone', models: ['jev-latest', 'jev-1.13'] });
    expect(JSON.stringify(created)).not.toContain('ts-secret-key');

    const foreign = await call('b', 'PATCH', '/v1/settings', { models: { systemOneModel: { providerId: created.id, modelId: 'jev-latest' } } });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ error: { code: 'UNKNOWN_PROVIDER' } });
    const unlisted = await call('a', 'PATCH', '/v1/settings', { models: { systemOneModel: { providerId: created.id, modelId: 'nope' } } });
    expect(unlisted.status).toBe(400);
    expect(await unlisted.json()).toMatchObject({ error: { code: 'UNKNOWN_MODEL' } });
    for (const models of [{ tiers: { fast: { providerId: created.id, modelId: 'jev-latest' } } }, { providerId: created.id, defaultModel: 'jev-latest' }]) {
      const chat = await call('a', 'PATCH', '/v1/settings', { models });
      expect(chat.status).toBe(400);
      expect(await chat.json()).toMatchObject({ error: { code: 'UNKNOWN_PROVIDER' } });
    }
    const chatProvider = await (await call('a', 'POST', '/v1/model-providers', { kind: 'custom', name: 'Chat', baseUrl: 'https://llm.example/v1', wire: 'openai-completions', apiKey: 'k' })).json() as { id: string };
    expect((await call('a', 'PATCH', '/v1/settings', { models: { systemOneModel: { providerId: chatProvider.id, modelId: 'x' } } })).status).toBe(400);
  });

  it('stores a valid choice, answers with the effective System One model, and null returns to Auto', async () => {
    const call = build();
    const created = await (await call('a', 'POST', '/v1/model-providers', jev)).json() as { id: string };
    const saved = appSettingsResponseSchema.parse(await (await call('a', 'PATCH', '/v1/settings', { models: { systemOneModel: { providerId: created.id, modelId: 'jev-1.13' } } })).json());
    expect(saved.models?.systemOneModel).toEqual({ providerId: created.id, modelId: 'jev-1.13' });
    expect(saved.effectiveSystemOneModel).toEqual({ providerId: 'p', modelId: 'jev-latest', source: 'chosen' });
    const auto = appSettingsResponseSchema.parse(await (await call('a', 'PATCH', '/v1/settings', { models: { systemOneModel: null } })).json());
    expect(auto.models?.systemOneModel).toBeNull();
  });
});
