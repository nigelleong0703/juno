import type { BackendConfig } from './config.js';
import type { ModelProvider } from './brain/index.js';
import { createOpenAIProvider } from './brain/index.js';
import { createDynamicScriptedModel } from './testing/index.js';
import { parsePricingTable, pricingFor } from './brain/model-pricing.js';

/** Log sink for the selected model mode, so selection stays pure and testable. */
export type ModelSelectionLog = (fields: Record<string, unknown>, message: string) => void;

const noLog: ModelSelectionLog = () => {};

/**
 * Strict env boolean for vision support: only the literal true/false count, so an empty or misspelled
 * value fails loudly instead of silently leaving screenshots as "(image omitted)".
 */
export function parseSupportsImages(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Unknown MODEL_SUPPORTS_IMAGES=${raw} (use "true" or "false")`);
}

/**
 * Pick the model provider from the raw env before touching Postgres or Restate, so a misconfigured
 * runner fails fast and names the missing setting. The scripted test double is opt-in only
 * (MODEL_PROVIDER=scripted).
 *
 * Check the raw env values, not the parsed config: loadConfig defaults MODEL_ID, so a parsed-config
 * check would silently accept a runner with no explicitly configured model.
 */
/** True when the platform default endpoint (MODEL_BASE_URL and MODEL_ID) is set in the raw env. */
export function platformModelConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['MODEL_BASE_URL']) && Boolean(env['MODEL_ID']);
}

export function selectProvider(
  env: NodeJS.ProcessEnv,
  config: BackendConfig,
  log: ModelSelectionLog = noLog,
): ModelProvider | undefined {
  if (env['MODEL_PROVIDER'] === 'scripted') {
    const file = env['SCRIPTED_MODEL_FILE'];
    if (!file) throw new Error('MODEL_PROVIDER=scripted requires SCRIPTED_MODEL_FILE');
    log({ file }, 'Model provider: scripted');
    // A small window lets a scenario make the harness compact a long chat.
    const window = Number(env['SCRIPTED_CONTEXT_WINDOW']);
    return createDynamicScriptedModel(file, Number.isFinite(window) && window > 0 ? { contextWindow: window } : undefined);
  }
  if (env['MODEL_PROVIDER']) {
    throw new Error(`Unknown MODEL_PROVIDER=${env['MODEL_PROVIDER']} (use "scripted" or leave unset)`);
  }

  // The platform default is optional: without MODEL_BASE_URL/MODEL_ID the runner starts, and an owner
  // must bring a model provider of their own (a run without one fails with MODEL_PROVIDER_REQUIRED).
  if (!platformModelConfigured(env)) {
    log({}, 'Model provider: platform default not configured');
    return undefined;
  }

  const supportsImages = parseSupportsImages(env['MODEL_SUPPORTS_IMAGES']);
  const pricing = pricingFor(parsePricingTable(config.MODEL_PRICING_JSON || env['MODEL_PRICING_JSON']), config.MODEL_BASE_URL, config.MODEL_ID);
  log({ baseUrl: config.MODEL_BASE_URL, model: config.MODEL_ID, supportsImages }, 'Model provider: openai-compatible');
  return createOpenAIProvider(config, pricing === undefined ? { supportsImages } : { supportsImages, pricing });
}
