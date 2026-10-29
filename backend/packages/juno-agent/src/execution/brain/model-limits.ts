import { z } from 'zod';
import type { BackendConfig } from '../config.js';
import type { ModelProvider } from './provider.js';

/**
 * Authoritative limits reported by the configured model server. A field the server does not
 * report stays undefined: an unknown maximum is never guessed, so the provider can leave it off
 * the wire request and the brain can skip a threshold it cannot justify.
 */
export interface ModelLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelLimitsSource {
  /** Cached, single-flight lookup of the configured model's limits. Never rejects. */
  getLimits(): Promise<ModelLimits>;
}

/** A model provider that can report the configured model's real limits. */
export interface LimitsAwareProvider extends ModelProvider {
  getLimits?(): Promise<ModelLimits>;
}

// Only the limit fields are read; everything else in the upstream document is ignored.
const modelEntrySchema = z
  .object({
    id: z.string().optional(),
    context_window: z.number().optional(),
    context_length: z.number().optional(),
    capabilities: z.object({ context_length: z.number().optional() }).optional(),
    max_output_tokens: z.number().optional(),
    max_completion_tokens: z.number().optional(),
    max_tokens: z.number().optional(),
    top_provider: z.object({ max_completion_tokens: z.number().optional() }).optional(),
    limit: z.object({ output: z.number().optional() }).optional(),
  })
  .passthrough();

const modelsResponseSchema = z.object({ data: z.array(modelEntrySchema) }).passthrough();

/** The /models probe must never stall a run. */
const MODELS_TIMEOUT_MS = 3_000;
// Real limits are stable for the process; an empty or transient answer is retried after a pause
// so a momentary fetch failure is not remembered forever.
const RESOLVED_TTL_MS = 5 * 60_000;
const UNRESOLVED_TTL_MS = 15_000;

function firstLimit(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** Keep only the limit fields the server actually reported. */
export function knownLimits(limits: ModelLimits): ModelLimits {
  const known: ModelLimits = {};
  const contextWindow = firstLimit(limits.contextWindow);
  if (contextWindow !== undefined) known.contextWindow = contextWindow;
  const maxOutputTokens = firstLimit(limits.maxOutputTokens);
  if (maxOutputTokens !== undefined) known.maxOutputTokens = maxOutputTokens;
  return known;
}

function readLimits(entry: z.infer<typeof modelEntrySchema>): ModelLimits {
  return knownLimits({
    contextWindow: firstLimit(entry.context_window, entry.context_length, entry.capabilities?.context_length),
    maxOutputTokens: firstLimit(
      entry.max_output_tokens,
      entry.max_completion_tokens,
      entry.max_tokens,
      entry.top_provider?.max_completion_tokens,
      entry.limit?.output,
    ),
  });
}

function hasLimits(limits: ModelLimits): boolean {
  return limits.contextWindow !== undefined || limits.maxOutputTokens !== undefined;
}

async function fetchModelLimits(baseUrl: string, apiKey: string, modelId: string, fetchFn: typeof fetch | undefined): Promise<ModelLimits> {
  const payload = await fetchModelsDocument(baseUrl, apiKey, fetchFn);
  if (payload === null) return {};
  try {
    const parsed = modelsResponseSchema.safeParse(payload);
    if (!parsed.success) return {};
    const entry = parsed.data.data.find(candidate => candidate.id === modelId);
    return entry === undefined ? {} : readLimits(entry);
  } catch {
    return {};
  }
}

/**
 * Shared upstream GET {baseUrl}/models probe: bounded timeout, parsed JSON or null on any
 * transport, status or shape failure. The caller decides what the document means; the API
 * key only ever leaves in the Authorization header, never in a return value or error.
 */
export async function fetchModelsDocument(
  baseUrl: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = MODELS_TIMEOUT_MS,
): Promise<unknown | null> {
  if (baseUrl.length === 0) return null;
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  try {
    const response = await fetchFn(url, {
      headers: apiKey.length > 0 ? { authorization: 'Bearer ' + apiKey } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return data;
  } catch {
    return null;
  }
}

/** Where a limits probe goes: the endpoint, the model, the credential read at probe time and the transport. */
export interface LimitsTarget {
  baseUrl: string;
  modelId: string;
  apiKey(): Promise<string>;
  /** Transport for the probe (SSRF-guarded for an owner endpoint). Absent uses the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Resolve a model's limits from GET {baseUrl}/models. Concurrent callers share one probe; a resolved
 * answer is cached longer than a transient miss, which is retried. The key is read at probe time and
 * only ever leaves in the Authorization header.
 */
export function createLimitsSourceFor(target: LimitsTarget): ModelLimitsSource {
  let cached: { limits: ModelLimits; expiresAt: number } | undefined;
  let inFlight: Promise<ModelLimits> | undefined;
  return {
    getLimits(): Promise<ModelLimits> {
      if (cached !== undefined && Date.now() < cached.expiresAt) return Promise.resolve(cached.limits);
      if (inFlight === undefined) {
        inFlight = target.apiKey()
          .then(apiKey => fetchModelLimits(target.baseUrl, apiKey, target.modelId, target.fetch))
          .then(limits => {
            cached = { limits, expiresAt: Date.now() + (hasLimits(limits) ? RESOLVED_TTL_MS : UNRESOLVED_TTL_MS) };
            return limits;
          })
          .catch((): ModelLimits => ({}))
          .finally(() => {
            inFlight = undefined;
          });
      }
      return inFlight;
    },
  };
}

/** The platform default's limits: GET {MODEL_BASE_URL}/models with the configured key. */
export function createModelLimitsSource(config: BackendConfig): ModelLimitsSource {
  const { MODEL_BASE_URL, MODEL_API_KEY, MODEL_ID } = config;
  return createLimitsSourceFor({ baseUrl: MODEL_BASE_URL, modelId: MODEL_ID, apiKey: async () => MODEL_API_KEY });
}
