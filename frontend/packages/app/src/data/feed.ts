import type { FeedPost, FeedbackInput, ListResult } from "@agent-desktop/client";
import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useClient } from "./ClientProvider";
import { prefix } from "./keys";
import { useFeed } from "./queries";

/** The cache shape of `useFeed`: every loaded page, in order. */
export type FeedPages = InfiniteData<ListResult<FeedPost>, string | undefined>;

/** Apply `update` to the post with this id in every cached feed (any filter, any page). */
export function updateFeedPost(qc: QueryClient, id: string, update: (post: FeedPost) => FeedPost): void {
  for (const [key, data] of qc.getQueriesData<FeedPages>({ queryKey: prefix.feed })) {
    if (!data) continue;
    qc.setQueryData<FeedPages>(key, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((post) => (post.id === id ? update(post) : post)),
      })),
    });
  }
}

/**
 * Like or unlike a post. Optimistic: the heart moves at once and rolls back if the server says no.
 * The `feed.updated` event (and the reply) then settle the count from the server.
 */
export function useLikeFeedPost() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, liked }: { id: string; liked: boolean }) => client.feed.like(id, liked),
    onMutate: ({ id, liked }) => {
      const before = qc.getQueriesData<FeedPages>({ queryKey: prefix.feed });
      updateFeedPost(qc, id, (post) => ({ ...post, liked }));
      return { before };
    },
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.before ?? []) qc.setQueryData(key, data);
    },
    onSuccess: (post) => updateFeedPost(qc, post.id, () => post),
  });
}

/** Local midnight of today, as epoch ms. */
export function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Today's feed posts, newest first (the first feed page already holds the newest 20). */
export function useTodayFeedPosts(): FeedPost[] {
  const { data } = useFeed();
  const midnight = startOfToday();
  return (data?.pages[0]?.items ?? []).filter((post) => Date.parse(post.createdAt) >= midnight);
}

const FEED_SEEN_KEY = "feed.lastSeen";
const feedSeenListeners = new Set<() => void>();

function readFeedSeenAt(): number {
  try {
    return Number(localStorage.getItem(FEED_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Remember that the user has looked at the Feed now (per browser; a convenience, not account state). */
export function markFeedSeen(): void {
  try {
    localStorage.setItem(FEED_SEEN_KEY, String(Date.now()));
  } catch {
    // Storage blocked: the badge just stays until the next visit.
  }
  for (const listener of feedSeenListeners) listener();
}

/** How many of today's posts arrived after the Feed was last opened: the Feed nav badge. */
export function useUnseenFeedCount(): number {
  const seenAt = useSyncExternalStore(
    (listener) => {
      feedSeenListeners.add(listener);
      return () => feedSeenListeners.delete(listener);
    },
    readFeedSeenAt,
  );
  return useTodayFeedPosts().filter((post) => Date.parse(post.createdAt) > seenAt).length;
}

// --- Feedback ---------------------------------------------------------------

/** Feedback on a post ("more" / "less", and why); the reply replaces the post in every cached feed. */
export function useFeedPostFeedback() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: FeedbackInput }) => client.feed.feedback(id, input),
    onSuccess: (post) => updateFeedPost(qc, post.id, () => post),
  });
}
