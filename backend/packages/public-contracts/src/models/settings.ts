import { z } from 'zod';
import { idSchema } from './common.js';
import { modelProviderSchema } from './model-providers.js';

export const themePreferenceSchema = z.enum(['light', 'dark', 'system']);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;

export const notificationChannelSchema = z.enum(['desktop', 'email', 'slack']);

export const notificationSettingSchema = z.object({
  type: z.enum(['approval', 'question', 'routine', 'task_failed', 'computer']),
  enabled: z.boolean(),
  channels: z.array(notificationChannelSchema),
});
export type NotificationSetting = z.infer<typeof notificationSettingSchema>;

/**
 * The reasoning levels pi-ai can send as `reasoning_effort`. This is the SDK's own set, not an
 * invented one: a gateway may advertise more (for example `ultra`), and the catalog ignores levels
 * outside this list because the client cannot transmit them.
 */
export const reasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** Account-wide model choice and runtime controls. Optional on AppSettings so stored rows written
 * before this section still parse; fresh defaults always include it. Every control is optional and
 * absent/null means "provider default, send nothing" so an older row keeps working unchanged. */
/** The owner's System One pick: one of their `systemone` providers and one of the model ids it lists. */
export const systemOneModelChoiceSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().trim().min(1),
});
export type SystemOneModelChoice = z.infer<typeof systemOneModelChoiceSchema>;

export const webSearchModeSchema = z.enum(['auto', 'juno']);
export type WebSearchMode = z.infer<typeof webSearchModeSchema>;

/**
 * One effort tier the owner can tune. Everything is optional; absent means the default. `modelId` (with `providerId` for one of the
 * owner's providers, none for the platform default) picks the model; `effort` picks the reasoning level and must be one the row's
 * model offers. `providerId` needs a `modelId`.
 */
export const tierRowSchema = z.object({
  providerId: z.string().min(1).optional(),
  modelId: z.string().trim().min(1).optional(),
  effort: reasoningEffortSchema.optional(),
}).strict().refine((row) => row.providerId === undefined || row.modelId !== undefined, { message: 'providerId needs a modelId' });
export type TierRow = z.infer<typeof tierRowSchema>;

export const tierNames = ['chat', 'task', 'deep', 'fast'] as const;
export type TierName = (typeof tierNames)[number];

/**
 * The four tiers: `chat` (the owner's conversations), `task` (child tasks, routines, jobs), `deep` (child_spawn deep) and `fast`
 * (child_spawn fast and the background one-shots). A PATCH replaces the whole object (send every row to keep); `null` clears all.
 * On `fast` an `effort` needs a `modelId`: its default model is a fallback chain whose levels are not known up front.
 */
export const tiersSchema = z.object({
  chat: tierRowSchema.optional(),
  task: tierRowSchema.optional(),
  deep: tierRowSchema.optional(),
  fast: tierRowSchema.optional(),
}).strict().refine((tiers) => tiers.fast?.effort === undefined || tiers.fast.modelId !== undefined, { message: 'fast effort needs a fast modelId' });
export type Tiers = z.infer<typeof tiersSchema>;

export const modelSettingsSchema = z.object({
  defaultModel: z.string().trim().min(1).nullable(),
  /** The owner's provider the default model belongs to; null/absent means the platform default endpoint. */
  providerId: z.string().min(1).nullable().optional(),
  /** Sampling temperature; omitted when unset so the provider keeps its own default. */
  temperature: z.number().min(0).max(2).nullable().optional(),
  /** Requested reply cap; clamped to the model's published maximum when the gateway reports one. */
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  /**
   * Per-tier model and reasoning effort (chat, task, deep, fast); `defaultModel` stays the main model every unset row uses. A row's
   * provider must be the owner's own and its model in that catalog (`UNKNOWN_PROVIDER` / `UNKNOWN_MODEL`, 400); its effort one
   * the model offers (`UNSUPPORTED_EFFORT`, 400). null/absent: every row default.
   */
  tiers: tiersSchema.nullable().optional(),
  /**
   * The System One (typed-decision) model, used for judgments such as the purchase and dialog reviewers. null/absent is
   * Auto. The provider must be the owner's own of kind `systemone` and the model one of its listed ids
   * (`UNKNOWN_PROVIDER` / `UNKNOWN_MODEL`, 400).
   */
  systemOneModel: systemOneModelChoiceSchema.nullable().optional(),
  /**
   * Where web search comes from. `auto` (null/absent) uses the model provider's own search tool when the run's model has one
   * (OpenAI, Anthropic) and Juno's search otherwise; `juno` always uses Juno's search. Frozen per run.
   */
  webSearch: webSearchModeSchema.nullable().optional(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const modelCatalogItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  supportsImages: z.boolean(),
  /**
   * Reasoning efforts the gateway advertises **and** pi-ai can send. Optional so a response from a
   * server that predates the controls still parses; absent means "not described" (no control offered),
   * while an empty list means "described as offering none".
   */
  reasoningEfforts: z.array(reasoningEffortSchema).optional(),
  /** True when the model also accepts reasoning effort `none` (no thinking). `none` is not an owner setting, so it is not in `reasoningEfforts`. */
  noReasoning: z.literal(true).optional(),
  /** True on the one model per built-in provider the platform recommends for background work (small and fast). */
  cheap: z.literal(true).optional(),
  /** True when the provider runs web search itself for this model (its own search tool), so Juno's search is not offered with it. */
  nativeWebSearch: z.literal(true).optional(),
});
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

export const modelCatalogSchema = z.object({
  defaultModel: z.string().min(1),
  items: z.array(modelCatalogItemSchema),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

/** The id of an owner's settings row. */
export function settingsIdFor(ownerId: string): string {
  return 'app-settings-' + ownerId;
}

/** True for a well-formed BCP 47 locale tag (en-SG, zh-Hans-SG). */
export function isLocale(value: string): boolean {
  if (value.length > 35 || !/^[A-Za-z0-9-]+$/.test(value)) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

/** True for an IANA zone name the runtime knows (Asia/Singapore); never an offset or free text. */
export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const appSettingsSchema = z.object({
  general: z.object({
    launchAtLogin: z.boolean(),
    defaultAgentId: idSchema.optional(),
    language: z.enum(['en', 'zh-CN']),
    /**
     * The owner's IANA timezone (Asia/Singapore), like Slack's user `tz`: the agent's "current
     * time", the default for routines the agent schedules, and the computer's clock. Clients set it
     * from the device while `timezoneAuto` is not false; a manual choice sets `timezoneAuto: false`.
     */
    timezone: z.string().optional(),
    timezoneAuto: z.boolean().optional(),
    /** The device's BCP 47 locale (en-SG), reported with the timezone: region, currency, units, formats. */
    locale: z.string().optional(),
  }),
  appearance: z.object({
    theme: themePreferenceSchema,
    density: z.enum(['comfortable', 'compact']),
    accent: z.string(),
  }),
  notifications: z.array(notificationSettingSchema),
  /** PH11: optional owner-global run budgets. Absent fields are unenforced, never invented. */
  usage: z
    .object({
      steps: z.number().int().min(0).optional(),
      tokens: z.number().int().min(0).optional(),
      activeSeconds: z.number().min(0).optional(),
      costUsd: z.number().min(0).optional(),
      /** PH11: when a configured budget cannot be measured exactly, block or enforce only the known lower bound. */
      onUnknown: z.enum(['block', 'ignore']).optional(),
    })
    .optional(),
  yourComputer: z.object({
    allowLocalAccess: z.boolean(),
    folders: z.array(z.string()),
    permissionsStatus: z.enum(['granted', 'denied', 'not_requested']),
  }),
  connections: z.object({
    serverUrl: z.string(),
    modelProviders: z.array(modelProviderSchema),
  }),
  privacy: z.object({
    dataRetentionDays: z.number().int().min(0),
    trainingOptIn: z.boolean(),
  }),
  advanced: z.object({
    releaseTrack: z.enum(['stable', 'beta', 'nightly']),
    logsEnabled: z.boolean(),
    networkDebugger: z.boolean(),
  }),
  models: modelSettingsSchema.optional(),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

/** Deep-partial patch accepted by `settings.update()`. Nested objects accept
 * any subset of fields; arrays replace whole and each entry is validated. */
export const updateSettingsInputSchema = appSettingsSchema
  .extend({
    // Device-reported values are checked where they come in; reads stay lenient so a client with an
    // older timezone or locale database still parses what the server stores.
    general: appSettingsSchema.shape.general.extend({
      timezone: z.string().refine(isTimeZone, 'timezone must be an IANA name like Asia/Singapore').optional(),
      locale: z.string().refine(isLocale, 'locale must be a BCP 47 tag like en-SG').optional(),
    }).partial(),
    appearance: appSettingsSchema.shape.appearance.partial(),
    yourComputer: appSettingsSchema.shape.yourComputer.partial(),
    connections: appSettingsSchema.shape.connections.partial(),
    privacy: appSettingsSchema.shape.privacy.partial(),
    advanced: appSettingsSchema.shape.advanced.partial(),
    // Strict: a removed key (reasoningEffort, fastModel) is a 400, never silently dropped.
    models: modelSettingsSchema.partial().strict(),
  })
  .partial();
export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;

/**
 * The fast model background calls would use right now for this owner (internal: System One emulation and the effective `fast` tier).
 * `providerId` is null for the platform default endpoint. `source`: `chosen` (the `fast` tier's model), `platform` (the platform's
 * fast model), `cheap` (the recommended small model of their default provider) or `agent` (their agent model).
 */
export const effectiveFastModelSchema = z.object({
  providerId: z.string().min(1).nullable(),
  modelId: z.string().min(1),
  source: z.enum(['chosen', 'platform', 'cheap', 'agent']),
});
export type EffectiveFastModel = z.infer<typeof effectiveFastModelSchema>;

/**
 * The System One model decisions would use right now. `source`: `chosen` (their `systemOneModel`), `platform` (the
 * platform's own System One endpoint) or `fast-model-emulation` (no System One model: the fast chat model answers the
 * same typed questions; `providerId`/`modelId` are then the fast model's). null: none, and callers fail closed.
 */
export const effectiveSystemOneModelSchema = z.object({
  providerId: z.string().min(1).nullable(),
  modelId: z.string().min(1),
  source: z.enum(['chosen', 'platform', 'fast-model-emulation']),
});
export type EffectiveSystemOneModel = z.infer<typeof effectiveSystemOneModelSchema>;

/**
 * What one tier runs on right now. `providerId` is null for the platform default endpoint; `effort` is the level it sends, `none`
 * when it sends no reasoning on purpose, null when the model offers no levels. `source`: `chosen` (the owner set the model, the
 * effort or both for this row) or `default` (the row's default model and effort). The client shows "Default - <model>, <effort>".
 */
export const effectiveTierSchema = z.object({
  providerId: z.string().min(1).nullable(),
  modelId: z.string().min(1),
  effort: z.union([reasoningEffortSchema, z.literal('none')]).nullable(),
  source: z.enum(['chosen', 'default']),
});
export type EffectiveTier = z.infer<typeof effectiveTierSchema>;

/** The four tiers as they resolve now; a row is null when no model can run it (no provider configured yet). */
export const effectiveTiersSchema = z.object({
  chat: effectiveTierSchema.nullable(),
  task: effectiveTierSchema.nullable(),
  deep: effectiveTierSchema.nullable(),
  fast: effectiveTierSchema.nullable(),
});
export type EffectiveTiers = z.infer<typeof effectiveTiersSchema>;

/** What `GET /v1/settings` and `PATCH /v1/settings` answer: the settings plus the resolved tiers and System One model (null: none usable). */
export const appSettingsResponseSchema = appSettingsSchema.extend({
  effectiveTiers: effectiveTiersSchema.nullable(),
  effectiveSystemOneModel: effectiveSystemOneModelSchema.nullable(),
});
export type AppSettingsResponse = z.infer<typeof appSettingsResponseSchema>;
