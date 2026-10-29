import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

/**
 * Wire protocols a model provider can speak. Built-in providers use the catalog's own api for each
 * model (anthropic-messages included); a custom provider is OpenAI-compatible only, so it offers
 * completions or responses.
 */
export const modelWireSchema = z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']);
export type ModelWire = z.infer<typeof modelWireSchema>;

export const customModelWireSchema = z.enum(['openai-completions', 'openai-responses']);
export type CustomModelWire = z.infer<typeof customModelWireSchema>;

/** A built-in provider the platform ships a model catalog for. Keys are always the owner's own. */
export const builtinModelProviderSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  authKinds: z.array(z.literal('api_key')),
  modelCount: z.number().int().min(0),
});
export type BuiltinModelProvider = z.infer<typeof builtinModelProviderSchema>;

/**
 * One provider an owner configured. `hasKey` is the only credential signal: the key itself is
 * write-only and never returned. `providerId` names the built-in catalog for kind `builtin`;
 * `baseUrl` and `wire` describe the endpoint for kind `custom`.
 */
/** How a built-in provider is authorized: the owner's API key, or their ChatGPT subscription sign-in. */
export const modelProviderAuthSchema = z.enum(['apiKey', 'chatgpt']);
export type ModelProviderAuth = z.infer<typeof modelProviderAuthSchema>;

/** `reauth_required`: a ChatGPT sign-in was refused on refresh; the owner must sign in again. */
export const modelProviderStatusSchema = z.enum(['connected', 'reauth_required']);
export type ModelProviderStatus = z.infer<typeof modelProviderStatusSchema>;

export const modelProviderSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  /** `systemone`: a typed-decision endpoint (Jev / TypeSafe-compatible), not a chat provider; it lists `models`. */
  kind: z.enum(['builtin', 'custom', 'systemone']),
  providerId: z.string().min(1).optional(),
  baseUrl: z.string().optional(),
  wire: modelWireSchema.optional(),
  /** `systemone` only: the model ids the endpoint offers. */
  models: z.array(z.string().min(1)).optional(),
  hasKey: z.boolean(),
  /** Absent means an API key (rows written before ChatGPT sign-in existed). */
  auth: modelProviderAuthSchema.optional(),
  status: modelProviderStatusSchema.optional(),
  /** ChatGPT only: when the current access token expires (never the token itself). */
  accessExpiresAt: isoDateTimeSchema.optional(),
});
export type ModelProvider = z.infer<typeof modelProviderSchema>;

const systemOneModelIdsSchema = z.array(z.string().trim().min(1).max(200)).min(1).max(20);

export const createModelProviderInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('builtin'),
    providerId: z.string().min(1).max(80),
    apiKey: z.string().min(1).max(4096),
  }),
  z.object({
    kind: z.literal('custom'),
    name: z.string().trim().min(1).max(80),
    baseUrl: z.string().trim().url().max(2048),
    wire: customModelWireSchema,
    apiKey: z.string().min(1).max(4096),
  }),
  z.object({
    kind: z.literal('systemone'),
    name: z.string().trim().min(1).max(80),
    baseUrl: z.string().trim().url().max(2048),
    models: systemOneModelIdsSchema,
    apiKey: z.string().min(1).max(4096),
  }),
]);
export type CreateModelProviderInput = z.infer<typeof createModelProviderInputSchema>;

/** Partial update. Built-in providers take only apiKey and name; custom providers take name, baseUrl, wire and apiKey, systemone providers name, baseUrl, models and apiKey. */
export const updateModelProviderInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    baseUrl: z.string().trim().url().max(2048).optional(),
    wire: customModelWireSchema.optional(),
    /** `systemone` providers only. */
    models: systemOneModelIdsSchema.optional(),
    apiKey: z.string().min(1).max(4096).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'nothing to update');
export type UpdateModelProviderInput = z.infer<typeof updateModelProviderInputSchema>;

export const builtinModelProviderListSchema = z.object({ items: z.array(builtinModelProviderSchema) });
export type BuiltinModelProviderList = z.infer<typeof builtinModelProviderListSchema>;

/**
 * The owner's providers plus whether a run can start at all. `usable` is true when the platform default
 * is configured or the owner chose a model (`settings.models.providerId` + `defaultModel`) of one of their
 * providers that has a key; otherwise the client should prompt for setup (connect a provider, then pick its model).
 */
export const modelProviderListSchema = z.object({
  providers: z.array(modelProviderSchema),
  platformDefault: z.boolean(),
  usable: z.boolean(),
});
export type ModelProviderList = z.infer<typeof modelProviderListSchema>;

/** Start a ChatGPT sign-in: the URL the owner opens in their browser, and the id to complete it with. */
export const chatgptLoginStartResultSchema = z.object({
  authorizationUrl: z.string().url(),
  loginId: idSchema,
  /** True when the engine catches the browser's redirect itself (desktop local mode); the owner then pastes nothing. */
  automatic: z.boolean(),
});
export type ChatGPTLoginStartResult = z.infer<typeof chatgptLoginStartResultSchema>;

/** Complete a ChatGPT sign-in with the full callback URL the browser ended on (manual paste). */
export const completeChatGPTLoginInputSchema = z.object({
  loginId: idSchema,
  callbackUrl: z.string().trim().min(1).max(4096),
});
export type CompleteChatGPTLoginInput = z.infer<typeof completeChatGPTLoginInputSchema>;

/** Where a ChatGPT sign-in stands: waiting for the browser, done (with the provider), or failed with a code the client words. */
export const chatgptLoginStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('connected'), provider: modelProviderSchema }),
  z.object({ status: z.literal('failed'), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type ChatGPTLoginStatus = z.infer<typeof chatgptLoginStatusSchema>;
