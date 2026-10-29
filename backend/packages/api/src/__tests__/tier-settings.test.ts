/**
 * The effort tiers (settings.models.tiers; BACKEND, lane -> tier table): each row names one of the caller's own providers and a
 * model in its catalog, and an effort that model offers. Settings answer with what each tier resolves to now.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import { appSettingsResponseSchema } from '@agent-desktop/public-contracts';
import { createApiApp, type ApiAuth } from '../server.js';
import type { ModelProviderCatalogClient } from '../modules/model-providers.js';

const auth: ApiAuth = {
  info: { mode: 'account', providers: ['credential'] },
  handle: async () => new Response('auth', { status: 200 }),
  resolve: async () => ({ ownerId: 'owner-a' }),
};

const EFFECTIVE = { providerId: 'mprov-mine', modelId: 'big-1', effort: 'low' as const, source: 'default' as const };

/** Only `mprov-mine` belongs to the caller; any other id is another owner's (agentd answers not-found). */
const providerClient: ModelProviderCatalogClient = {
  async builtinProviders() {
    return [];
  },
  async providerModels(_owner, providerId) {
    return providerId === 'mprov-mine'
      ? { kind: 'ok', catalog: { defaultModel: 'big-1', items: [{ id: 'big-1', name: 'Big', supportsImages: false, reasoningEfforts: ['low', 'high'] }, { id: 'small-1', name: 'Small', supportsImages: false, cheap: true, reasoningEfforts: ['low'] }] } }
      : { kind: 'not-found' };
  },
  async effectiveTiers() {
    return { chat: EFFECTIVE, task: EFFECTIVE, deep: { ...EFFECTIVE, effort: 'high' }, fast: { ...EFFECTIVE, modelId: 'small-1', source: 'chosen' } };
  },
  async effectiveSystemOneModel() {
    return null;
  },
};

function build() {
  const app = createApiApp({ auth, agentdUrl: 'http://127.0.0.1:8788', internalToken: 't', fetch: async () => Response.json({}), store: createMemoryStore(), blobs: createMemoryBlobStore(), providerClient, platformDefault: false });
  return (method: string, body?: unknown) => Promise.resolve(app.request('/v1/settings', {
    method,
    headers: { Authorization: 'Bearer s', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

const MAIN = { providerId: 'mprov-mine', defaultModel: 'big-1' };

describe('settings.models.tiers', () => {
  it('rejects another owner\'s provider, a model outside the catalog and an effort the model does not offer', async () => {
    const call = build();
    const foreign = await call('PATCH', { models: { tiers: { fast: { providerId: 'mprov-theirs', modelId: 'small-1' } } } });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ error: { code: 'UNKNOWN_PROVIDER' } });
    const unknown = await call('PATCH', { models: { tiers: { task: { providerId: 'mprov-mine', modelId: 'nope' } } } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: 'UNKNOWN_MODEL' } });
    const effort = await call('PATCH', { models: { tiers: { task: { providerId: 'mprov-mine', modelId: 'small-1', effort: 'high' } } } });
    expect(effort.status).toBe(400);
    expect(await effort.json()).toMatchObject({ error: { code: 'UNSUPPORTED_EFFORT' } });
    expect((await (await call('GET')).json() as { models: { tiers?: unknown } }).models.tiers).toBeUndefined();
  });

  it('checks an effort-only row against the main model, and a main-model change against the rows it keeps', async () => {
    const call = build();
    expect((await call('PATCH', { models: { ...MAIN, tiers: { chat: { effort: 'medium' } } } })).status).toBe(400);
    expect((await call('PATCH', { models: { ...MAIN, tiers: { chat: { effort: 'high' } } } })).status).toBe(200);
    const switched = await call('PATCH', { models: { providerId: 'mprov-mine', defaultModel: 'small-1' } });
    expect(switched.status).toBe(400);
    expect(await switched.json()).toMatchObject({ error: { code: 'UNSUPPORTED_EFFORT' } });
  });

  it('refuses a malformed tiers object and the removed reasoningEffort and fastModel keys', async () => {
    const call = build();
    for (const models of [
      { tiers: { chat: { effort: 'ultra' } } },
      { tiers: { fast: { effort: 'low' } } },
      { tiers: { task: { providerId: 'mprov-mine' } } },
      { tiers: { slow: {} } },
      { reasoningEffort: 'high' },
      { fastModel: { providerId: 'mprov-mine', modelId: 'small-1' } },
    ]) {
      expect((await call('PATCH', { models })).status, JSON.stringify(models)).toBe(400);
    }
  });

  it('stores the rows, replaces them whole, answers with the effective tiers, and null clears them', async () => {
    const call = build();
    const saved = await call('PATCH', { models: { ...MAIN, tiers: { chat: { effort: 'high' }, fast: { providerId: 'mprov-mine', modelId: 'small-1' } } } });
    expect(saved.status).toBe(200);
    const parsed = appSettingsResponseSchema.parse(await saved.json());
    expect(parsed.models?.tiers).toEqual({ chat: { effort: 'high' }, fast: { providerId: 'mprov-mine', modelId: 'small-1' } });
    expect(parsed.effectiveTiers).toMatchObject({ deep: { effort: 'high' }, fast: { modelId: 'small-1', source: 'chosen' } });
    const replaced = appSettingsResponseSchema.parse(await (await call('PATCH', { models: { tiers: { task: { effort: 'low' } } } })).json());
    expect(replaced.models?.tiers).toEqual({ task: { effort: 'low' } });
    expect(appSettingsResponseSchema.parse(await (await call('GET')).json()).models?.tiers).toEqual({ task: { effort: 'low' } });
    const cleared = appSettingsResponseSchema.parse(await (await call('PATCH', { models: { tiers: null } })).json());
    expect(cleared.models?.tiers).toBeNull();
  });
});
