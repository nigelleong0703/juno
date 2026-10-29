/**
 * The model the platform reflector calls. There is no owner here, so it is the platform's own endpoint (platform-paid): `REFLECTOR_MODEL_*`,
 * else the fast model's `FAST_MODEL_*`. Any OpenAI-compatible `/chat/completions` endpoint. With none configured the reflector is off and
 * everything else (exposure, labels, metrics, canary, rollback) still runs.
 */
import type { Complete } from './reflector.js';

export interface PlatformModelEnv {
  modelId: string;
  baseUrl: string;
  apiKey: string;
}

type Env = Record<string, string | undefined>;

export function readPlatformModelEnv(env: Env): PlatformModelEnv | undefined {
  const pick = (...names: string[]): string => names.map((name) => env[name]?.trim() ?? '').find((value) => value !== '') ?? '';
  const modelId = pick('REFLECTOR_MODEL_ID', 'FAST_MODEL_ID');
  const baseUrl = pick('REFLECTOR_MODEL_BASE_URL', 'FAST_MODEL_BASE_URL', 'MODEL_BASE_URL');
  if (modelId === '' || baseUrl === '') return undefined;
  return { modelId, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: pick('REFLECTOR_MODEL_API_KEY', 'FAST_MODEL_API_KEY', 'MODEL_API_KEY') || 'none' };
}

/** One tool-less chat call: null on any failure (a bad status, a refusal, an empty answer, a timeout). */
export function createChatComplete(model: PlatformModelEnv, fetchFn: typeof fetch = fetch): Complete {
  return async (system, prompt, signal) => {
    try {
      const response = await fetchFn(`${model.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
        body: JSON.stringify({ model: model.modelId, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
        signal,
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      const choices = typeof body === 'object' && body !== null ? Reflect.get(body, 'choices') : undefined;
      const message: unknown = Array.isArray(choices) && typeof choices[0] === 'object' && choices[0] !== null ? Reflect.get(choices[0], 'message') : undefined;
      const content = typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : undefined;
      return typeof content === 'string' && content.trim() !== '' ? content : null;
    } catch {
      return null;
    }
  };
}
