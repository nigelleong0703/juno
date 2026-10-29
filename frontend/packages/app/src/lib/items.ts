import type { Item } from "@agent-desktop/client";

/**
 * Per-variant item types extracted from the `Item` discriminated union.
 * `packages/client` exports the union (`Item`) but not the member types, so the app derives
 * them here rather than re-declaring the shapes (they stay in lock-step with the schema).
 */
export type UserMessageItem = Extract<Item, { type: "user_message" }>;
export type AgentMessageItem = Extract<Item, { type: "agent_message" }>;
export type RunItem = Extract<Item, { type: "run" }>;
export type PlanItem = Extract<Item, { type: "plan" }>;
export type RequestItem = Extract<Item, { type: "request" }>;
export type ArtifactItem = Extract<Item, { type: "artifact" }>;
export type RoutineItem = Extract<Item, { type: "routine" }>;
export type HandoffItem = Extract<Item, { type: "handoff" }>;
export type SystemItem = Extract<Item, { type: "system" }>;
export type FeedRefItem = Extract<Item, { type: "feed_ref" }>;
export type RoleSuggestionItem = Extract<Item, { type: "role_suggestion" }>;

/**
 * "Posted to Feed" cards read after the run's final reply: each `feed_ref` moves right behind the last
 * agent message of its run (it stays where it is when the run has no later agent message).
 */
export function feedRefsAfterReply(items: Item[]): Item[] {
  const lastReply = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.type === "agent_message" && item.runId) lastReply.set(item.runId, index);
  });
  const moved = new Map<number, Item[]>();
  const rest = items.filter((item, index) => {
    const at = item.type === "feed_ref" && item.runId ? lastReply.get(item.runId) : undefined;
    if (at === undefined || at < index) return true;
    moved.set(at, [...(moved.get(at) ?? []), item]);
    return false;
  });
  if (moved.size === 0) return items;
  return items.flatMap((item, index) => (rest.includes(item) ? [item, ...(moved.get(index) ?? [])] : []));
}

/** Runs that posted to the Feed: their replies' sources belong to the post, not the chat. */
export const runsWithFeedRef = (items: Item[]): Set<string> =>
  new Set(items.flatMap((item) => (item.type === "feed_ref" && item.runId ? [item.runId] : [])));
