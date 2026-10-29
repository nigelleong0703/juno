import { z } from 'zod';
import {
  systemOneModelChoiceSchema,
  tiersSchema,
  webSearchModeSchema,
  type WebSearchMode,
  type SystemOneModelChoice,
  type Tiers,
  type ModelCatalogItem,
  type ReasoningEffort,
} from '@agent-desktop/public-contracts';
import { effortForTier, type EffortTier } from './reasoning-tier.js';
import { measuredEfforts } from './model-catalog-fields.js';

/** Account runtime controls read from one owner's settings row and frozen onto a run's snapshot. */
export interface ModelRuntimeControls {
  defaultModel: string | null;
  /** The owner's provider document the default model belongs to; absent/null is the platform default. */
  providerId?: string | null;
  temperature?: number;
  maxOutputTokens?: number;
  /** The owner's per-tier model and effort (chat, task, deep, fast); an absent row is its default. */
  tiers?: Tiers;
  /** The owner's System One choice; absent is Auto. */
  systemOneModel?: SystemOneModelChoice;
  /** Where web search comes from; absent is auto (the provider's own search when the model has one). */
  webSearch?: WebSearchMode;
}

/**
 * The stored models section. Every control is optional so a row written before runtime controls
 * existed still parses; a wrong-typed or out-of-range value fails the parse and the caller turns
 * that into a loud misconfiguration error instead of silently dropping the owner's choice.
 */
const storedModelsSchema = z
  .object({
    models: z
      .object({
        defaultModel: z.string().trim().min(1).nullable().optional(),
        providerId: z.string().min(1).nullable().optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
        maxOutputTokens: z.number().int().positive().nullable().optional(),
        // A malformed system choice reads as Auto: background calls must never brick the agent's own runs.
        tiers: tiersSchema.nullable().optional().catch(undefined),
        systemOneModel: systemOneModelChoiceSchema.nullable().optional().catch(undefined),
        webSearch: webSearchModeSchema.nullable().optional().catch(undefined),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type StoredModels = NonNullable<z.infer<typeof storedModelsSchema>['models']>;

export type StoredModelSettings =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'controls'; controls: ModelRuntimeControls };

/** True when a stored row carries a non-null models section, however malformed. */
function sectionPresent(row: object): boolean {
  for (const [key, value] of Object.entries(row)) {
    if (key !== 'models') continue;
    return value !== undefined && value !== null;
  }
  return false;
}

function normalizeControls(models: StoredModels): ModelRuntimeControls {
  const controls: ModelRuntimeControls = { defaultModel: models.defaultModel ?? null };
  if (models.providerId !== null && models.providerId !== undefined) controls.providerId = models.providerId;
  if (models.temperature !== null && models.temperature !== undefined) {
    controls.temperature = models.temperature;
  }
  if (models.maxOutputTokens !== null && models.maxOutputTokens !== undefined) {
    controls.maxOutputTokens = models.maxOutputTokens;
  }
  if (models.tiers !== null && models.tiers !== undefined) controls.tiers = models.tiers;
  if (models.systemOneModel !== null && models.systemOneModel !== undefined) controls.systemOneModel = models.systemOneModel;
  if (models.webSearch !== null && models.webSearch !== undefined) controls.webSearch = models.webSearch;
  return controls;
}

/**
 * Read the account model section from a stored settings row. A missing (or explicitly null) section
 * is a legacy row and falls back to the env default; a present but malformed section is a
 * misconfiguration the caller must fail loudly rather than silently run a model nobody chose.
 */
export function readStoredModelSettings(row: unknown): StoredModelSettings {
  if (typeof row !== 'object' || row === null) return { kind: 'absent' };
  const parsed = storedModelsSchema.safeParse(row);
  if (!parsed.success) return sectionPresent(row) ? { kind: 'invalid' } : { kind: 'absent' };
  const models = parsed.data.models;
  if (models === undefined) return sectionPresent(row) ? { kind: 'invalid' } : { kind: 'absent' };
  return { kind: 'controls', controls: normalizeControls(models) };
}

/** Capability-driven reasoning acceptance for one resolved model. */
export type ReasoningAcceptance = 'accepted' | 'rejected' | 'unknown';

/**
 * Whether a requested effort may be sent to this model. A catalogued model advertises exactly the
 * pi-ai levels it accepts: a listed level is accepted and any other is rejected. An uncatalogued
 * model, or one upstream did not describe, is `unknown`, so the caller omits the option instead of
 * asserting a disabled state that was never checked.
 */
export function reasoningAcceptance(item: ModelCatalogItem | undefined, effort: ReasoningEffort): ReasoningAcceptance {
  const efforts = item?.reasoningEfforts;
  if (efforts === undefined) return 'unknown';
  return efforts.includes(effort) ? 'accepted' : 'rejected';
}

/** The controls actually carried by a run; absent fields keep the provider's own default. */
export interface FrozenRuntimeControls {
  reasoningEffort?: ReasoningEffort;
  /** Responses wire only: send no reasoning at all (the model's offered levels are unknown). */
  omitReasoning?: true;
  temperature?: number;
  maxOutputTokens?: number;
}

export type FreezeRuntimeControlsResult =
  | { kind: 'frozen'; controls: FrozenRuntimeControls }
  | { kind: 'rejected-reasoning'; effort: ReasoningEffort; modelId: string }
  | { kind: 'unverified-reasoning'; effort: ReasoningEffort; modelId: string };

/**
 * Freeze the account controls for one resolved model. Capability-driven: the reasoning effort is
 * carried only when the model advertises it. A model that advertises other levels, or that the
 * catalog could not describe at all, is never silently dropped: each returns a distinct failure so
 * the caller can report exactly why the requested control cannot be honoured. Temperature and the
 * output request pass through as given; the provider clamps the output request to the known maximum.
 */
export function freezeRuntimeControls(
  controls: ModelRuntimeControls | undefined,
  item: ModelCatalogItem | undefined,
  modelId: string,
  /** The wire the run speaks; only Responses can send `none` (by leaving the level out) or needs an explicit "no reasoning". */
  wire: string | undefined,
  /** The lane's tier: the effort used when the row sets none. */
  tier: EffortTier,
  /** The effort the owner set on the lane's tier row; it always wins over the tier. */
  effort?: ReasoningEffort,
): FreezeRuntimeControlsResult {
  const frozen: FrozenRuntimeControls = {};
  if (effort !== undefined) {
    const acceptance = reasoningAcceptance(item, effort);
    if (acceptance === 'rejected') return { kind: 'rejected-reasoning', effort, modelId };
    if (acceptance === 'unknown') return { kind: 'unverified-reasoning', effort, modelId };
    frozen.reasoningEffort = effort;
  } else {
    // No catalog entry (the platform default on a gateway of our own): the measured table still knows the model's levels.
    const measured = item === undefined ? measuredEfforts(modelId) : undefined;
    const described = item ?? (measured === undefined ? undefined : { reasoningEfforts: measured.efforts, ...(measured.noReasoning ? { noReasoning: true as const } : {}) });
    const chosen = effortForTier(tier, described, wire);
    if (chosen.kind === 'effort') frozen.reasoningEffort = chosen.effort;
    // Unknown levels: Responses must say "no reasoning" itself (its own default is `none`, which Muse Spark refuses).
    else if (chosen.kind === 'omit' && wire === 'openai-responses') frozen.omitReasoning = true;
  }
  if (controls?.temperature !== undefined) frozen.temperature = controls.temperature;
  if (controls?.maxOutputTokens !== undefined) frozen.maxOutputTokens = controls.maxOutputTokens;
  return { kind: 'frozen', controls: frozen };
}
