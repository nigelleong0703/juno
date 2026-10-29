import type { ReasoningEffort } from '@agent-desktop/public-contracts';
import type { Model, ModelCost, Models, OpenAICompletionsCompat } from '@earendil-works/pi-ai';
import { hasApi } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { ModelLimits } from './model-limits.js';
import { modelPricingSchema } from './model-pricing.js';

/** The one replay rule a DeepSeek-thinking upstream enforces on OpenAI-compatible routes. */
export interface AssistantWireCompat {
  requiresReasoningContentOnAssistantMessages: boolean;
}

const notRequired: AssistantWireCompat = { requiresReasoningContentOnAssistantMessages: false };

let manifest: Models | undefined;

/** The generated registry is static package data; one shared instance serves the process. */
function manifestModels(): Models {
  if (manifest === undefined) manifest = builtinModels();
  return manifest;
}

/** MODEL_ID may name a catalog model directly ("deepseek-v4.1-flash") or as "provider/model". */
function findManifestModel(models: Models, modelId: string) {
  for (const provider of models.getProviders()) {
    const direct = models.getModel(provider.id, modelId);
    if (direct !== undefined) return direct;
  }
  const separator = modelId.indexOf('/');
  if (separator <= 0 || separator === modelId.length - 1) return undefined;
  return models.getModel(modelId.slice(0, separator), modelId.slice(separator + 1));
}

/**
 * Read the pi-ai model manifest for the configured MODEL_ID so provider-specific wire rules
 * (DeepSeek thinking) follow the model id, not hand-built defaults. Unknown ids and models
 * outside the OpenAI-completions API stay plain OpenAI-compatible.
 */
export function assistantWireCompatFor(modelId: string): AssistantWireCompat {
  const entry = findManifestModel(manifestModels(), modelId);
  if (entry === undefined || !hasApi(entry, 'openai-completions')) return notRequired;
  return {
    requiresReasoningContentOnAssistantMessages:
      entry.compat?.requiresReasoningContentOnAssistantMessages === true,
  };
}

export interface WireModelRequest {
  modelId: string;
  baseUrl: string;
  supportsImages: boolean;
  /** Account-frozen effort; absent keeps defaults. */
  reasoningEffort?: ReasoningEffort;
  /** Responses wire: send no reasoning at all (frozen when the model's offered levels are unknown). */
  omitReasoning?: boolean;
  limits: ModelLimits;
  /** Explicit USD-per-million-token rates for this exact endpoint/model; absent stays unknown. */
  pricing?: ModelCost;
  /** Replay identity of the wire model (its `provider` field). Default `openai`; an owner's provider names itself. */
  providerName?: string;
}

function validatedPricing(pricing: ModelCost | undefined): ModelCost | undefined {
  if (pricing === undefined) return undefined;
  const parsed = modelPricingSchema.safeParse(pricing);
  if (!parsed.success) throw new Error('Invalid model pricing: rates must be finite numbers >= 0');
  return { input: parsed.data.input, output: parsed.data.output, cacheRead: parsed.data.cacheRead, cacheWrite: parsed.data.cacheWrite };
}

/**
 * The OpenAI-completions wire identity: host defaults for everything, plus the manifest rule for
 * the flagged route. Account-frozen effort keeps its explicit control; the flagged rule mirrors
 * pi-ai: replayed assistant turns carry reasoning_content (empty when the turn produced no
 * thinking, non-empty signatures verbatim), the developer role stays off, and without a frozen
 * level the thinking parameter format is pinned so no reasoning request parameter is invented.
 * Explicit pricing reaches the wire cost verbatim; missing pricing leaves zero wire cost and the
 * usage layer still reports unknown (zero wire cost alone never means free).
 */
export function wireModelFor(request: WireModelRequest): Model<'openai-completions'> {
  const { modelId, baseUrl, supportsImages, reasoningEffort, limits, pricing, providerName = 'openai' } = request;
  const wireCompat = assistantWireCompatFor(modelId);
  const compat: OpenAICompletionsCompat = {};
  if (reasoningEffort !== undefined) compat.supportsReasoningEffort = true;
  if (wireCompat.requiresReasoningContentOnAssistantMessages) {
    compat.requiresReasoningContentOnAssistantMessages = true;
    compat.supportsDeveloperRole = false;
    if (reasoningEffort === undefined) compat.thinkingFormat = 'openai';
  }
  const cost = validatedPricing(pricing) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    api: 'openai-completions',
    provider: providerName,
    id: modelId,
    name: modelId,
    baseUrl,
    input: supportsImages ? ['text', 'image'] : ['text'],
    cost,
    reasoning: reasoningEffort !== undefined || wireCompat.requiresReasoningContentOnAssistantMessages,
    compat,
    contextWindow: limits.contextWindow ?? 0,
    maxTokens: limits.maxOutputTokens ?? 0,
  };
}

/**
 * The OpenAI Responses wire identity (the shape Codex sends). `reasoning` is true unless the run froze
 * `omitReasoning`: pi-ai then sends the run's frozen effort (the account's, or the one chosen from the
 * model's offered levels; `none` only when the model offers it) and, whenever an effort is set, asks for
 * `reasoning.encrypted_content` with `store:false`, so the reasoning items come back and are replayed
 * as opaque items instead of plain text. Pricing and limits ride like on the completions identity.
 */
export function responsesModelFor(request: WireModelRequest): Model<'openai-responses'> {
  const { modelId, baseUrl, supportsImages, omitReasoning, limits, pricing, providerName = 'openai' } = request;
  const cost = validatedPricing(pricing) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    api: 'openai-responses',
    provider: providerName,
    id: modelId,
    name: modelId,
    baseUrl,
    input: supportsImages ? ['text', 'image'] : ['text'],
    cost,
    reasoning: omitReasoning !== true,
    contextWindow: limits.contextWindow ?? 0,
    maxTokens: limits.maxOutputTokens ?? 0,
  };
}
