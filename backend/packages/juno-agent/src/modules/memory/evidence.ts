/** Checks the model's claims against the sources they cite (BACKEND §5.4): the code checks, not the model. */
import type { MemoryEvidence } from '@agent-desktop/public-contracts';

/** Prefix of the id the hourly job gives an agent's daily log when it shows it to the model. */
export const LOG_SOURCE_PREFIX = 'log:';

/**
 * The evidence whose quote appears word for word in the cited message; the rest is dropped. `sources` holds messages people
 * wrote. A daily log is an agent's paraphrase, so it is never evidence, even when a caller puts one in `sources`.
 */
export function verifyEvidence(evidence: readonly MemoryEvidence[], sources: ReadonlyMap<string, string>): MemoryEvidence[] {
  return evidence.flatMap((entry) => {
    const quote = entry.quote.trim();
    const source = entry.itemId.startsWith(LOG_SOURCE_PREFIX) ? undefined : sources.get(entry.itemId);
    return quote.length > 0 && source !== undefined && source.includes(quote) ? [{ itemId: entry.itemId, quote }] : [];
  });
}

/** Text compared without case, punctuation or spacing, so a retracted claim is recognized when the model words it again. */
export const normalizeClaimText = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export interface ClaimLike {
  text: string;
  evidence: readonly MemoryEvidence[];
}

/** True when `claim` says the same thing as one of `others`. */
export function repeatsText(claim: ClaimLike, others: readonly ClaimLike[]): boolean {
  const text = normalizeClaimText(claim.text);
  return others.some((other) => normalizeClaimText(other.text) === text);
}

/** True when `claim` says the same thing as one of the retracted `others`, or rests on the same words of the same source. */
export function repeatsRetracted(claim: ClaimLike, others: readonly ClaimLike[]): boolean {
  return repeatsText(claim, others)
    || others.some((other) => other.evidence.some((seen) => claim.evidence.some((now) => now.itemId === seen.itemId && now.quote === seen.quote)));
}
