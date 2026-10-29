/** Member @mention parsing for the composer (MN1).
 *
 * Only actual conversation participants passed in as candidates can resolve:
 * an exact case-insensitive full-handle match against exactly one candidate
 * produces a canonical Mention. Email addresses, code spans, unknown handles
 * and ambiguous handles (two candidates sharing one handle) never resolve,
 * so sending can never silently invite a member or invent an ID.
 */
import type { AvatarSpec, Mention } from "@agent-desktop/client";

export interface MentionCandidate {
  id: string;
  handle: string;
  name?: string;
  /** Picker avatar; broadcast rows and bare candidates have none. */
  avatar?: AvatarSpec;
  /** Secondary row label (e.g. an agent title); optional. */
  title?: string;
}

/** A live @token under the cursor the picker can complete. */
export interface ActiveMentionToken {
  /** Offset of the @ inside the full composer value. */
  start: number;
  /** Text after the @ (may be empty for a bare @). */
  query: string;
}

const HANDLE_TOKEN = /@([A-Za-z0-9_.-]+)/g;
const ACTIVE_TOKEN = /(^|[\s([{\u2018\u201c'",;:])@([A-Za-z0-9_-]*)$/;

function isWordChar(char: string): boolean {
  return char !== "" && /[A-Za-z0-9_.]/.test(char);
}

/** Explicit broadcast aliases. They resolve to a canonical broadcast Mention by
 * label (recognized by the backend wake path, no member validation); they never
 * invite anyone, and unknown handles still resolve to nothing. */
export const BROADCAST_ALIASES = ["all", "everyone"] as const;
export type BroadcastAlias = (typeof BROADCAST_ALIASES)[number];

/** Canonical broadcast Mention for an alias token, or null for anything else. */
export function broadcastMentionFor(token: string): Mention | null {
  const alias = token.toLowerCase();
  if (alias !== "all" && alias !== "everyone") return null;
  return { kind: "agent", id: alias, label: "@" + alias };
}

/** Picker row that selects the whole group; carries the canonical broadcast ID. */
export function broadcastCandidate(label: string): MentionCandidate {
  return { id: "all", handle: "all", name: label };
}

/** Blank code spans and fences so handles inside code never become recipients. */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`?/g, " ");
}

/** Exact unambiguous member handles in first-seen order, deduplicated by ID. */
export function parseMentions(text: string, candidates: MentionCandidate[]): Mention[] {
  const byHandle = new Map<string, MentionCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.handle.toLowerCase();
    const group = byHandle.get(key);
    if (group) group.push(candidate);
    else byHandle.set(key, [candidate]);
  }
  const clean = stripCode(text);
  const seen = new Set<string>();
  const mentions: Mention[] = [];
  HANDLE_TOKEN.lastIndex = 0;
  for (const match of clean.matchAll(HANDLE_TOKEN)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const token = raw.replace(/\.+$/, "");
    if (token === "") continue;
    const index = match.index ?? 0;
    if (isWordChar(clean[index - 1] ?? "")) continue;
    const broadcast = broadcastMentionFor(token);
    if (broadcast !== null) {
      if (!seen.has(broadcast.id)) {
        seen.add(broadcast.id);
        mentions.push(broadcast);
      }
      continue;
    }
    const group = byHandle.get(token.toLowerCase());
    if (!group || group.length !== 1) continue;
    const winner = group[0];
    if (winner === undefined || seen.has(winner.id)) continue;
    seen.add(winner.id);
    mentions.push({ kind: "agent", id: winner.id, label: "@" + winner.handle });
  }
  return mentions;
}

/** The @token ending exactly at the cursor, or null when the cursor is not on one. */
export function findActiveMentionToken(beforeCursor: string): ActiveMentionToken | null {
  const match = ACTIVE_TOKEN.exec(beforeCursor);
  const query = match?.[2];
  if (!match || query === undefined) return null;
  return { start: beforeCursor.lastIndexOf("@"), query };
}

/** Picker candidates for a query: everyone for a bare @, else a handle/name prefix. */
export function matchCandidates(query: string, candidates: MentionCandidate[]): MentionCandidate[] {
  const needle = query.toLowerCase();
  if (needle === "") return [...candidates];
  return candidates.filter((candidate) => {
    if (
      candidate.handle.toLowerCase().startsWith(needle) ||
      (candidate.name ?? "").toLowerCase().startsWith(needle)
    )
      return true;
    // The broadcast row answers to every alias, not just its own handle.
    if (candidate.id === "all" && ("all".startsWith(needle) || "everyone".startsWith(needle)))
      return true;
    return false;
  });
}
