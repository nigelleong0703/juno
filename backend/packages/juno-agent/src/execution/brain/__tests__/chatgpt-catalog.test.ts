// A ChatGPT sign-in offers the plan's own models (OpenAI's remote list for that token), not the 44-model
// API-key catalog: hidden models and models pi-ai cannot run are dropped, and reasoning levels are narrowed
// to what OpenAI accepts for the model. The token goes only to the models request.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { sealChatGPTBundle } from '../chatgpt-credential.js';
import { userProviderCatalog } from '../user-provider-catalog.js';

const OWNER = 'owner-a';
const ACCESS = 'chatgpt-access-token-test';

beforeAll(() => {
  process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
});
afterAll(() => {
  delete process.env['SECRETS_KEY'];
});

async function chatgptProvider() {
  const store = createMemoryStore();
  const sealed = sealChatGPTBundle({ type: 'oauth', access: ACCESS, refresh: 'refresh-token', expires: Date.now() + 3_600_000, clientId: 'client', scopes: [] });
  await runWithOwner(OWNER, () =>
    store.put('modelProviders', {
      id: 'mprov-chatgpt', ownerId: OWNER, kind: 'builtin', name: 'OpenAI (ChatGPT subscription)', providerId: 'openai',
      auth: 'chatgpt', status: 'connected', ...sealed, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
    }),
  );
  return store;
}

describe('ChatGPT sign-in model catalog', () => {
  it('lists only the plan models OpenAI shows for the token, with the levels both sides accept', async () => {
    const store = await chatgptProvider();
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return Response.json({
        models: [
          { slug: 'gpt-5.6-sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
          { slug: 'gpt-5.5', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
          { slug: 'codex-auto-review', visibility: 'list' },
          { slug: 'gpt-6-luna', visibility: 'list' },
        ],
      });
    };
    const result = await runWithOwner(OWNER, () => userProviderCatalog(store, OWNER, 'mprov-chatgpt', { fetchFn }));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.catalog.items.map((item) => item.id)).toEqual(['gpt-5.6-sol', 'gpt-6-luna']);
    expect(result.catalog.defaultModel).toBe('gpt-5.6-sol');
    expect(result.catalog.items[0]?.reasoningEfforts).toEqual(['low', 'high']);
    expect(seen).toEqual([{ url: 'https://api.openai.com/v1/models', auth: `Bearer ${ACCESS}` }]);
    expect(JSON.stringify(result)).not.toContain(ACCESS);
  });

  it('is unavailable (never the API-key catalog) when OpenAI does not answer', async () => {
    const store = await chatgptProvider();
    const fetchFn: typeof fetch = async () => new Response('{}', { status: 502 });
    const result = await runWithOwner(OWNER, () => userProviderCatalog(store, OWNER, 'mprov-chatgpt', { fetchFn }));
    expect(result).toEqual({ kind: 'unavailable' });
  });
});
