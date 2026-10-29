import type { AssistantTurn, BrainContext } from '../../contracts/index.js';
import { estimateMessagesTokens, parseMessagesLenient } from './compaction.js';
import { readContextLimits } from './context.js';

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
 * gives undefined (overflow recovery handles it). The estimate is content-based, so a stale
 * pre-compaction usage snapshot cannot inflate it; undefined when no estimate is available.
 */
export function contextPressure(ctx: BrainContext): number | undefined {
  const { contextWindow, maxOutputTokens } = readContextLimits(ctx);
  // A slim (journaled) context carries the estimate taken at build time instead of the messages.
  const messages = parseMessagesLenient(ctx.messages);
  const tokens = messages.length > 0 ? estimateMessagesTokens(messages) : typeof ctx.contextTokens === 'number' ? ctx.contextTokens : undefined;
  if (tokens === undefined || tokens <= 0) return undefined;
  if (contextWindow === undefined || contextWindow <= 0) return undefined;
  const replyRoom = Math.min(maxOutputTokens ?? 0, Math.floor(contextWindow / 2));
  const threshold = Math.min(contextWindow * COMPACT_AT_WINDOW_SHARE, contextWindow - replyRoom, COMPACT_AT_MAX_TOKENS);
  return tokens / threshold;
}
