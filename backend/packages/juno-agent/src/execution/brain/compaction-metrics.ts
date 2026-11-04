import type { AssistantTurn, BrainContext } from '../../contracts/index.js';
import { estimateContextTokensForPressure, parseMessagesLenient } from './compaction.js';
import { parseModelSnapshot } from './model-selection.js';
import { readContextLimits } from './context.js';
import { TRIM_AT_SHARE, TRIM_NEXT_STEP } from './result-trim.js';

/** The private measurement the run accounting consumes (never a public contract). */
export interface CompactionMetrics {
  durationMs: number;
  usage?: AssistantTurn['usage'];
}

/** A copy of the context carrying this attempt measurement, never a stale one. */
export function withMetrics(context: BrainContext, spent: CompactionMetrics): BrainContext {
  return { ...context, compactionMetrics: spent };
}

/** A copy of the context with previous measurement dropped, so a no-op re-charges nothing. */
export function withoutMetrics(context: BrainContext): BrainContext {
  const copy: BrainContext = { sessionKey: context.sessionKey, agentId: context.agentId };
  for (const [key, value] of Object.entries(context)) {
    if (key !== 'compactionMetrics') copy[key] = value;
  }
  return copy;
}

/**
 * Compact once the context reaches this share of the model's context window. A code constant on
 * purpose: no API, setting or env var changes it.
 */
const COMPACT_AT_WINDOW_SHARE = 0.8;
/**
 * And never later than this many tokens, whatever the window: a busy chat (a Discord group never idle for an hour) grew
 * to 362k tokens per reply on a large window, and the model kept copying its own old replies.
 */
export const COMPACT_AT_MAX_TOKENS = 128_000;
/**
 * Context pressure for one turn inside a run: estimated context tokens divided by the compaction
 * threshold, which is COMPACT_AT_WINDOW_SHARE of the model's window, lowered further if the next reply
 * (the provider's output maximum) would not fit. Above 1 the turn compacts first. An unknown window
 * gives undefined (overflow recovery handles it). Measured usage is accepted only after the
 * current projection boundary; otherwise content estimates apply.
 */
function frozenModelId(ctx: BrainContext): string | undefined {
  try {
    return parseModelSnapshot(ctx)?.modelId;
  } catch {
    return undefined;
  }
}

export function contextPressure(ctx: BrainContext): number | undefined {
  const threshold = compactionThreshold(ctx);
  // A slim (journaled) context carries the estimate taken at build time instead of the messages.
  // The live estimate is measured-aware (last assistant usage + trailing
  // content, validated against stable rewrite timestamps); the model check
  // keeps a stale model generation from counting.
  const messages = parseMessagesLenient(ctx.messages);
  const tokens = messages.length > 0
    ? estimateContextTokensForPressure(messages, frozenModelId(ctx))
    : typeof ctx.contextTokens === 'number' ? ctx.contextTokens : undefined;
  if (tokens === undefined || tokens <= 0 || threshold === undefined) return undefined;
  return tokens / threshold;
}

/** The token count at which a turn compacts first; undefined while the model's window is unknown. */
export function compactionThreshold(ctx: BrainContext): number | undefined {
  const { contextWindow, maxOutputTokens } = readContextLimits(ctx);
  if (contextWindow === undefined || contextWindow <= 0) return undefined;
  const replyRoom = Math.min(maxOutputTokens ?? 0, Math.floor(contextWindow / 2));
  return Math.min(contextWindow * COMPACT_AT_WINDOW_SHARE, contextWindow - replyRoom, COMPACT_AT_MAX_TOKENS);
}

/**
 * Whether the old tool results are trimmed now (BACKEND §3.5.2b): the context is past a share of the compaction trigger but not at it (a
 * compaction comes first then), and it has grown by a step since the last trim (`trimBase`, the pressure that trim ended at), so
 * the cache breaks at most once per step of growth, never per call.
 */
export function trimDue(ctx: BrainContext): boolean {
  const pressure = contextPressure(ctx);
  if (pressure === undefined || pressure <= TRIM_AT_SHARE || pressure > 1) return false;
  const base = typeof ctx['trimBase'] === 'number' ? ctx['trimBase'] : 0;
  return pressure >= base + TRIM_NEXT_STEP;
}
