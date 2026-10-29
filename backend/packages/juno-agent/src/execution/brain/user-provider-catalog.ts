// The model catalog of one owner's provider: a built-in provider's pi-ai list, a ChatGPT sign-in's own
// remote list, or a custom endpoint's GET {baseUrl}/models answer. The custom probe uses the SSRF-guarded
// client and the owner's key, which leaves only in the Authorization header. Results carry ids and names,
// never the key, the token or upstream bodies.
import { z } from 'zod';
import type { ModelCatalog, ReasoningEffort } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';
import type { ModelProviderRecord } from '../../contracts/model-providers.js';
import { chatGPTAccessToken, pinnedChatGPTRefresh, type ChatGPTRefresh } from './chatgpt-credential.js';
import { createModelFetch } from '../../modules/tools/net/guardedFetch.js';
import { builtinCatalog } from './builtin-providers.js';
import { fetchModelsDocument } from './model-limits.js';
import { openProviderKey, readOwnedProvider } from './user-providers.js';

const modelsDocumentSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) }).passthrough()) }).passthrough();

/** Where a ChatGPT sign-in's token is sent (the openai provider's endpoint); its /models lists what the plan may use. */
const CHATGPT_MODELS_URL = 'https://api.openai.com/v1/models';

/**
 * What OpenAI answers a ChatGPT sign-in token on /models: the plan's own models (Codex-style `slug`), each
 * listed or hidden, with the reasoning levels it accepts. Unknown fields pass through untouched.
 */
const chatgptModelsDocumentSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      visibility: z.string().optional(),
      supported_reasoning_levels: z.array(z.object({ effort: z.string() }).passthrough()).optional(),
    }).passthrough(),
  ),
}).passthrough();

export interface UserProviderCatalogOptions {
  /** Transport for the ChatGPT models request; absent uses the global fetch. Injected in tests. */
  fetchFn?: typeof fetch;
  refresh?: ChatGPTRefresh;
}

export type UserProviderCatalog =
  | { kind: 'ok'; catalog: ModelCatalog }
  | { kind: 'not-found' }
  | { kind: 'unavailable' };

/** The catalog of an owner's provider. Another owner's provider is `not-found`, never readable. */
export async function userProviderCatalog(store: Store, ownerId: string, id: string, options: UserProviderCatalogOptions = {}): Promise<UserProviderCatalog> {
  const record = await readOwnedProvider(store, ownerId, id);
  if (record === undefined) return { kind: 'not-found' };
  if (record.kind === 'builtin' && record.auth === 'chatgpt') return chatgptCatalog(store, ownerId, record, options);
  if (record.kind === 'builtin') {
    const catalog = record.providerId === undefined ? undefined : builtinCatalog(record.providerId);
    return catalog === undefined ? { kind: 'unavailable' } : { kind: 'ok', catalog };
  }
  if (record.kind === 'systemone') {
    const [first, ...rest] = record.models ?? [];
    return first === undefined ? { kind: 'unavailable' } : { kind: 'ok', catalog: { defaultModel: first, items: [first, ...rest].map((id) => ({ id, name: id, supportsImages: false })) } };
  }
  if (record.baseUrl === undefined || record.apiKey.length === 0) return { kind: 'unavailable' };
  let apiKey: string;
  try {
    apiKey = openProviderKey(record.apiKey);
  } catch {
    return { kind: 'unavailable' };
  }
  const document = await fetchModelsDocument(record.baseUrl, apiKey, createModelFetch());
  const parsed = modelsDocumentSchema.safeParse(document);
  if (!parsed.success || parsed.data.data.length === 0) return { kind: 'unavailable' };
  const seen = new Set<string>();
  const items = parsed.data.data.flatMap((entry) => {
    if (seen.has(entry.id)) return [];
    seen.add(entry.id);
    return [{ id: entry.id, name: entry.id, supportsImages: false }];
  });
  const first = items[0];
  return first === undefined ? { kind: 'unavailable' } : { kind: 'ok', catalog: { defaultModel: first.id, items } };
}

/**
 * A ChatGPT sign-in's catalog is the plan's remote list, not the API-key catalog: only models OpenAI lists for
 * this token (hidden ones dropped) that pi-ai also knows (a run needs its limits and pricing), in OpenAI's order,
 * each offering the reasoning levels both sides accept. A refused refresh marks the row reauth_required.
 */
async function chatgptCatalog(store: Store, ownerId: string, record: ModelProviderRecord, options: UserProviderCatalogOptions): Promise<UserProviderCatalog> {
  const known = builtinCatalog('openai');
  if (known === undefined) return { kind: 'unavailable' };
  let document: unknown;
  try {
    const token = await chatGPTAccessToken({ store, ownerId, record, refresh: options.refresh ?? pinnedChatGPTRefresh });
    const response = await (options.fetchFn ?? fetch)(CHATGPT_MODELS_URL, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { kind: 'unavailable' };
    document = await response.json();
  } catch {
    return { kind: 'unavailable' };
  }
  const parsed = chatgptModelsDocumentSchema.safeParse(document);
  if (!parsed.success) return { kind: 'unavailable' };
  const items = parsed.data.models.flatMap((remote) => {
    if (remote.visibility === 'hide') return [];
    const item = known.items.find((candidate) => candidate.id === remote.slug);
    if (item === undefined) return [];
    const accepted = remote.supported_reasoning_levels?.map((level) => level.effort);
    const reasoningEfforts: ReasoningEffort[] | undefined =
      accepted === undefined ? item.reasoningEfforts : item.reasoningEfforts?.filter((effort) => accepted.includes(effort));
    // The plan's own list is authoritative for `none` too; a plan that does not list it cannot send it.
    const noReasoning = accepted === undefined ? item.noReasoning === true : accepted.includes('none');
    const { noReasoning: _own, ...rest } = item;
    return [{ ...rest, ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }), ...(noReasoning ? { noReasoning: true as const } : {}) }];
  });
  const first = items[0];
  return first === undefined ? { kind: 'unavailable' } : { kind: 'ok', catalog: { defaultModel: first.id, items } };
}
