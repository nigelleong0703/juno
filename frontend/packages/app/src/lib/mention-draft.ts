/** Named mention drafts for the composer (MP2, input side).
 *
 * The picker inserts the member's display name as plain draft text (no raw
 * handle), and the selected member's ID is tracked as a span over that name.
 * Typing the same words by hand creates no span, so a plain name never wakes
 * anyone. On submit, spans that still cover their exact name and whose member
 * is still present serialize to the canonical handle text plus Mention IDs
 * (the existing contract); anything else degrades to plain text. Explicit
 * handle tokens keep working through the shared parser.
 */
import type { Mention } from "@agent-desktop/client";
import { parseMentions, type MentionCandidate } from "./mentions";

/** A picker-selected display name inside the draft, authorized by member ID. */
export interface MentionDraftSpan {
  /** The selected member; never resolved by name. */
  id: string;
  /** The exact display-name text placed in the draft. */
  name: string;
  /** Inclusive offset of the name inside the draft (excludes trailing space). */
  start: number;
  /** Exclusive offset of the name inside the draft. */
  end: number;
}

/** Replace [anchor, end) with the display name plus a trailing space. Null when
 * the candidate has no usable name, so the caller can fall back to a handle. */
export function insertMentionDraft(
  value: string,
  anchor: number,
  end: number,
  candidate: MentionCandidate,
): { value: string; span: MentionDraftSpan } | null {
  const name = candidate.name ?? "";
  if (name === "") return null;
  const safeAnchor = Math.max(0, Math.min(anchor, value.length));
  const safeEnd = Math.max(safeAnchor, Math.min(end, value.length));
  const insertion = name + " ";
  return {
    value: value.slice(0, safeAnchor) + insertion + value.slice(safeEnd),
    span: { id: candidate.id, name, start: safeAnchor, end: safeAnchor + name.length },
  };
}

/** Shift spans around text edits; any span touched by the edit clears. */
export function reconcileMentionDrafts(
  prev: string,
  next: string,
  spans: MentionDraftSpan[],
): MentionDraftSpan[] {
  if (spans.length === 0 || prev === next) return spans;
  const minLen = Math.min(prev.length, next.length);
  let prefix = 0;
  while (prefix < minLen && prev.charAt(prefix) === next.charAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    prev.charAt(prev.length - 1 - suffix) === next.charAt(next.length - 1 - suffix)
  )
    suffix += 1;
  const removedEnd = prev.length - suffix;
  const delta = next.length - prev.length;
  const kept: MentionDraftSpan[] = [];
  for (const span of spans) {
    if (span.end <= prefix) {
      kept.push(span);
      continue;
    }
    if (span.start >= removedEnd) {
      kept.push({ ...span, start: span.start + delta, end: span.end + delta });
      continue;
    }
  }
  return kept;
}

/** Trim the draft, then serialize surviving spans to canonical handles and IDs. */
export function serializeMentionDraft(
  draft: string,
  spans: MentionDraftSpan[],
  candidates: MentionCandidate[],
): { text: string; mentions: Mention[] } {
  const text = draft.trim();
  const leftTrim = draft.length - draft.trimStart().length;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate] as const));
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const explicit: Mention[] = [];
  const seen = new Set<string>();
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    const start = span.start - leftTrim;
    const end = span.end - leftTrim;
    const candidate = byId.get(span.id);
    if (candidate === undefined) continue;
    if (start < cursor || start < 0 || end > text.length) continue;
    if (text.slice(start, end) !== span.name) continue;
    out += text.slice(cursor, start) + "@" + candidate.handle;
    cursor = end;
    if (!seen.has(candidate.id)) {
      seen.add(candidate.id);
      explicit.push({ kind: "agent", id: candidate.id, label: "@" + candidate.handle });
    }
  }
  out += text.slice(cursor);
  const mentions = [...explicit];
  for (const parsed of parseMentions(out, candidates)) {
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    mentions.push(parsed);
  }
  return { text: out, mentions };
}
