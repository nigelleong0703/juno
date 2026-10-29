// Reasoning-effort tiers. A run's lane picks a tier; the model's catalog turns the tier into the effort it
// accepts. The prompt cache is keyed per effort on the measured models, so the result is frozen on the run's
// model snapshot and a conversation's lane never changes (BACKEND.md, model and effort).
import { z } from 'zod';
import { reasoningEffortSchema, type ModelCatalogItem, type ReasoningEffort, type TierName } from '@agent-desktop/public-contracts';

export const effortTierSchema = z.enum(['quick', 'standard', 'deep']);
export type EffortTier = z.infer<typeof effortTierSchema>;

/** What kind of work a run does. A conversation keeps one lane for its whole life. */
export type EffortLane = 'chat' | 'child' | 'deep-child' | 'routine' | 'job';

/** The one table to change after measuring. Chat takes `chatTier` (CHAT_EFFORT_TIER). */
export function tierForLane(lane: EffortLane, chatTier: EffortTier): EffortTier {
  switch (lane) {
    case 'chat': return chatTier;
    case 'child': return 'standard';
    case 'deep-child': return 'deep';
    case 'routine': return 'standard';
    case 'job': return 'standard';
  }
}

/** The owner-configurable row a run reads (`settings.models.tiers`): chat; task = child, routine and job; deep; fast = a `fast` child. */
export function tierNameOf(lane: EffortLane, fast = false): TierName {
  if (fast) return 'fast';
  switch (lane) {
    case 'chat': return 'chat';
    case 'deep-child': return 'deep';
    default: return 'task';
  }
}

/** What the run sends for reasoning: a level, `none` (leave the level out; Responses then sends none), or nothing at all. */
export type TierEffort = { kind: 'effort'; effort: ReasoningEffort } | { kind: 'none' } | { kind: 'omit' };

/** The offered level closest to `target` in the ordered scale; the higher one on a tie. */
function nearest(offered: readonly ReasoningEffort[], target: ReasoningEffort): ReasoningEffort | undefined {
  const scale = reasoningEffortSchema.options;
  const want = scale.indexOf(target);
  let best: ReasoningEffort | undefined;
  let bestGap = Infinity;
  for (const level of offered) {
    const gap = Math.abs(scale.indexOf(level) - want);
    if (gap < bestGap || (gap === bestGap && best !== undefined && scale.indexOf(level) > scale.indexOf(best))) {
      best = level;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * The effort a tier gets on one model. quick: `none` when the model offers it (only the Responses wire can send it,
 * by leaving the level out), else `minimal`, else the lowest offered level. standard: `low` or the nearest offered.
 * deep: `high` or the nearest offered. A model that describes no levels (or a non-reasoning one) sends nothing.
 */
export function effortForTier(tier: EffortTier, item: Pick<ModelCatalogItem, 'reasoningEfforts' | 'noReasoning'> | undefined, wire: string | undefined): TierEffort {
  const offered = item?.reasoningEfforts;
  if (offered === undefined || offered.length === 0) return { kind: 'omit' };
  if (tier === 'quick') {
    if (item?.noReasoning === true && wire === 'openai-responses') return { kind: 'none' };
    const effort = offered.includes('minimal') ? 'minimal' : nearest(offered, 'minimal');
    return effort === undefined ? { kind: 'omit' } : { kind: 'effort', effort };
  }
  const effort = nearest(offered, tier === 'standard' ? 'low' : 'high');
  return effort === undefined ? { kind: 'omit' } : { kind: 'effort', effort };
}
