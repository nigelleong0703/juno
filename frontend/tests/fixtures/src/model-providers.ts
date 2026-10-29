/**
 * Mock `/v1/model-providers*`: the same rules and error codes as the backend routes (BACKEND.md §10.14).
 * Keys are write-only here too: only `hasKey` is kept, the key string is dropped on receipt.
 */
import type {
  BuiltinModelProvider,
  ModelCatalog,
  ModelCatalogItem,
  ModelProvider,
  ModelProvidersApi,
  ChatGPTLoginStatus,
  ReasoningEffort,
} from '@agent-desktop/client';
import { apiError } from './util.js';

export interface ModelProviderMockState {
  providers: ModelProvider[];
  /** Whether a platform default endpoint exists, so a run can start with no provider of the owner's own. */
  platformDefault: boolean;
}

const ALL_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

const model = (id: string, name: string, reasoningEfforts: ReasoningEffort[] = [], supportsImages = true, cheap = false): ModelCatalogItem => ({
  id,
  name,
  supportsImages,
  reasoningEfforts,
  ...(cheap ? { cheap: true as const } : {}),
});

/** A long enough list to exercise search: the real catalog has 34 providers. */
const BUILTIN: Array<BuiltinModelProvider & { models: ModelCatalogItem[] }> = [
  { id: 'openai', name: 'OpenAI', models: [model('gpt-5.5', 'GPT-5.5', ALL_EFFORTS), model('gpt-5.5-mini', 'GPT-5.5 mini', ['low', 'medium', 'high'], true, true), model('gpt-4.1', 'GPT-4.1')] },
  { id: 'anthropic', name: 'Anthropic', models: [model('claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high', 'max']), model('claude-sonnet-5-5', 'Claude Sonnet 5.5', ['low', 'medium', 'high']), model('claude-haiku-5-5', 'Claude Haiku 5.5', [], true, true)] },
  { id: 'openrouter', name: 'OpenRouter', models: Array.from({ length: 40 }, (_, i) => model(`vendor/model-${i + 1}`, `Router Model ${i + 1}`, i % 3 === 0 ? ['low', 'high'] : [], i % 2 === 0)) },
  { id: 'opencode-go', name: 'OpenCode Go', models: [model('muse-spark', 'Muse Spark', ['low', 'medium', 'high']), model('glm-5.3', 'GLM 5.3', [], false)] },
  { id: 'deepseek', name: 'DeepSeek', models: [model('deepseek-chat', 'DeepSeek Chat', [], false), model('deepseek-reasoner', 'DeepSeek Reasoner', ['high'], false)] },
  { id: 'google', name: 'Google', models: [model('gemini-3-pro', 'Gemini 3 Pro', ['low', 'high'])] },
  { id: 'mistral', name: 'Mistral', models: [model('mistral-large', 'Mistral Large', [], false)] },
  { id: 'groq', name: 'Groq', models: [model('llama-4-70b', 'Llama 4 70B', [], false)] },
  { id: 'xai', name: 'xAI', models: [model('grok-5', 'Grok 5', ['low', 'high'])] },
  { id: 'cerebras', name: 'Cerebras', models: [model('qwen-3-coder', 'Qwen 3 Coder', [], false)] },
  { id: 'fireworks', name: 'Fireworks', models: [model('kimi-k3', 'Kimi K3', [], false)] },
  { id: 'together', name: 'Together AI', models: [model('qwen3-235b', 'Qwen3 235B', [], false)] },
].map((row) => ({ ...row, authKinds: ['api_key' as const], modelCount: row.models.length }));

const CALLBACK_PREFIXES = ['http://127.0.0.1:1455/auth/callback', 'http://localhost:1455/auth/callback'];
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)/i;
const LOGIN_TTL_MS = 10 * 60_000;

function catalogFor(provider: ModelProvider): ModelCatalog {
  if (provider.kind === 'systemone') {
    const items = (provider.models ?? []).map((id) => model(id, id, [], false));
    return { defaultModel: items[0]?.id ?? 'jev-latest', items };
  }
  const builtin = BUILTIN.find((row) => row.id === provider.providerId);
  const items = builtin?.models ?? [model('custom-model', 'custom-model')];
  return { defaultModel: items[0]?.id ?? 'custom-model', items };
}

/** The catalog of one of the owner's providers, or null when it does not exist. */
export function providerCatalog(state: ModelProviderMockState, providerId: string): ModelCatalog | null {
  const provider = state.providers.find((row) => row.id === providerId);
  return provider ? catalogFor(provider) : null;
}

export function createModelProvidersMock(opts: {
  state: () => ModelProviderMockState;
  delay: () => Promise<void>;
  newId: () => string;
  now: () => number;
}): ModelProvidersApi {
  const logins = new Map<string, { state: string; expiresAt: number; consumed: boolean; outcome?: ChatGPTLoginStatus }>();
  const find = (id: string): ModelProvider => {
    const found = opts.state().providers.find((provider) => provider.id === id);
    if (!found) throw apiError(404, 'NOT_FOUND', 'Model provider not found');
    return found;
  };
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  return {
    async list() {
      await opts.delay();
      const { providers, platformDefault } = opts.state();
      return copy({ providers, platformDefault, usable: platformDefault || providers.some((provider) => provider.hasKey) });
    },
    async builtin() {
      await opts.delay();
      return { items: BUILTIN.map(({ models: _models, ...row }) => row) };
    },
    async create(input) {
      await opts.delay();
      let created: ModelProvider;
      if (input.kind === 'builtin') {
        const known = BUILTIN.find((row) => row.id === input.providerId);
        if (!known) throw apiError(400, 'UNKNOWN_PROVIDER', 'Unknown built-in provider');
        created = { id: `mprov-${opts.newId()}`, name: known.name, kind: 'builtin', providerId: known.id, hasKey: true };
      } else {
        if (PRIVATE_HOST.test(new URL(input.baseUrl).hostname)) throw apiError(400, 'MODEL_URL_BLOCKED', 'The model endpoint must be a public http(s) address');
        const base = { id: `mprov-${opts.newId()}`, name: input.name, baseUrl: input.baseUrl, hasKey: true };
        created = input.kind === 'custom' ? { ...base, kind: 'custom', wire: input.wire } : { ...base, kind: 'systemone', models: input.models };
      }
      opts.state().providers.push(created);
      return copy(created);
    },
    async update(id, patch) {
      await opts.delay();
      const current = find(id);
      if ((patch.baseUrl !== undefined || patch.wire !== undefined) && current.kind !== 'custom') {
        throw apiError(400, 'BUILTIN_ENDPOINT_FIXED', 'A built-in provider endpoint cannot be changed');
      }
      if (patch.baseUrl !== undefined && PRIVATE_HOST.test(new URL(patch.baseUrl).hostname)) {
        throw apiError(400, 'MODEL_URL_BLOCKED', 'The model endpoint must be a public http(s) address');
      }
      if (patch.models !== undefined && current.kind !== 'systemone') throw apiError(400, 'VALIDATION', 'Only a System One provider lists models');
      if (patch.models !== undefined) current.models = patch.models;
      if (patch.name !== undefined) current.name = patch.name;
      if (patch.baseUrl !== undefined) current.baseUrl = patch.baseUrl;
      if (patch.wire !== undefined) current.wire = patch.wire;
      if (patch.apiKey !== undefined) current.hasKey = true;
      return copy(current);
    },
    async delete(id) {
      await opts.delay();
      find(id);
      const state = opts.state();
      state.providers = state.providers.filter((provider) => provider.id !== id);
    },
    async models(id) {
      await opts.delay();
      return copy(catalogFor(find(id)));
    },
    async startChatGPTLogin() {
      await opts.delay();
      const loginId = `mlogin-${opts.newId()}`;
      const state = opts.newId();
      logins.set(loginId, { state, expiresAt: opts.now() + LOGIN_TTL_MS, consumed: false });
      const url = new URL('https://auth.openai.com/api/accounts/authorize');
      url.searchParams.set('redirect_uri', CALLBACK_PREFIXES[0]!);
      url.searchParams.set('state', state);
      return { authorizationUrl: url.toString(), loginId, automatic: false };
    },
    async completeChatGPTLogin({ loginId, callbackUrl }) {
      await opts.delay();
      const provider = await completeLogin(loginId, callbackUrl).catch((error: unknown) => {
        const pending = logins.get(loginId);
        const { code, message } = error as { code: string; message: string };
        if (pending) pending.outcome = { status: 'failed', error: { code, message } };
        throw error;
      });
      const pending = logins.get(loginId);
      if (pending) pending.outcome = { status: 'connected', provider };
      return provider;
    },
    async chatGPTLoginStatus(loginId) {
      await opts.delay();
      const pending = logins.get(loginId);
      if (!pending) throw apiError(404, 'NOT_FOUND', 'Sign-in not found');
      return copy(pending.outcome ?? { status: 'pending' });
    },
    async cancelChatGPTLogin(loginId) {
      await opts.delay();
      const pending = logins.get(loginId);
      if (!pending) throw apiError(404, 'NOT_FOUND', 'Sign-in not found');
      if (!pending.consumed) {
        pending.consumed = true;
        pending.outcome = { status: 'failed', error: { code: 'CANCELLED', message: 'The sign-in was cancelled' } };
      }
    },
  };

  async function completeLogin(loginId: string, callbackUrl: string): Promise<ModelProvider> {
    const pending = logins.get(loginId);
    if (!pending) throw apiError(404, 'NOT_FOUND', 'Sign-in not found');
    if (pending.consumed) throw apiError(400, 'LOGIN_INVALID', 'This sign-in was already used; start again');
    pending.consumed = true;
    if (pending.expiresAt <= opts.now()) throw apiError(400, 'LOGIN_EXPIRED', 'This sign-in expired; start again');
    const trimmed = callbackUrl.trim();
    if (!CALLBACK_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) throw apiError(400, 'CALLBACK_INVALID', 'Paste the full address the browser ended on');
    const params = new URL(trimmed).searchParams;
    if (!params.get('code')) throw apiError(400, 'CALLBACK_INVALID', 'Paste the full address the browser ended on');
    if (params.get('state') !== pending.state) throw apiError(400, 'STATE_MISMATCH', 'The callback does not belong to this sign-in; start again');
    const accessExpiresAt = new Date(opts.now() + 10 * 24 * 3600_000).toISOString();
    const state = opts.state();
    const existing = state.providers.find((provider) => provider.auth === 'chatgpt' && provider.providerId === 'openai');
    if (existing) {
      Object.assign(existing, { status: 'connected', accessExpiresAt, hasKey: true });
      return copy(existing);
    }
    const created: ModelProvider = {
      id: `mprov-${opts.newId()}`,
      name: 'OpenAI (ChatGPT subscription)',
      kind: 'builtin',
      providerId: 'openai',
      hasKey: true,
      auth: 'chatgpt',
      status: 'connected',
      accessExpiresAt,
    };
    state.providers.push(created);
    return copy(created);
  }
}
