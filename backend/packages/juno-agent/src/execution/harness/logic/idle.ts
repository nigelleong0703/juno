/**
 * Private-chat reply admission: coalesce a burst of 1:1 messages behind a durable idle window, bound
 * the "thinking" jitter, and refuse wakes that would let an agent recursively wake itself.
 *
 * Pure helpers only. The Session object owns the durable timer (a delayed Restate self-send), never a
 * process `setTimeout`, so a restart cannot lose a pending reply.
 */
import { createHash } from 'node:crypto';
import type { WakeEvent } from '../../../contracts/index.js';
import type { ConversationKind } from '@agent-desktop/public-contracts';

/** Quiet time after the last private message before the agent starts, like a person reading what you texted. A message sent while a run is active reaches it as steer. */
export const PRIVATE_IDLE_WINDOW_MS = 1000;

/** A typing ping is good for this long; clients ping at most once a second while composing, so 4 s of silence means they stopped. */
export const TYPING_TTL_MS = 4000;

/** The longest a burst start or a ready reply is held back for someone who keeps typing. */
export const MAX_TYPING_HOLD_MS = 30_000;

/** Upper bound on the extra "thinking" jitter (0 = none). */
export const PRIVATE_REPLY_JITTER_MAX_MS = 0;

export const isPrivateConversation = (kind: ConversationKind | undefined): boolean =>
  kind === 'direct' || kind === 'peer';

/** Deterministic jitter in [0, maxMs): the same message id always yields the same delay (durable-safe). */
export function boundedJitterMs(seed: string, maxMs: number = PRIVATE_REPLY_JITTER_MAX_MS): number {
  if (maxMs <= 1) return 0;
  const digest = createHash('sha256').update(seed).digest();
  return digest.readUInt32BE(0) % maxMs;
}

/** Durable delay for the idle flush: the quiet window plus the bounded, deterministic jitter. */
export function privateReplyDelayMs(seed: string): number {
  return PRIVATE_IDLE_WINDOW_MS + boundedJitterMs(seed);
}

export interface ReplyPrecheck {
  admit: boolean;
  reason: string;
}

/**
 * Structural self-wake admission: the wake must name an agent, and an agent-originated wake must not
 * target the very agent that sent it — the only way an agent could recursively wake itself, since
 * agent-to-agent wakes already name an explicit recipient. This is a structural gate: an admitted
 * wake always starts its run, there is no model reply decision.
 */
export function selfWakeAdmission(event: Pick<WakeEvent, 'agentId' | 'origin'>): ReplyPrecheck {
  if (event.agentId.length === 0) return { admit: false, reason: 'missing_agent' };
  if (event.origin.type === 'agent' && event.origin.id === event.agentId) {
    return { admit: false, reason: 'self_wake' };
  }
  return { admit: true, reason: 'ok' };
}
