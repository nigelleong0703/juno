import type { ApiClient, Conversation } from "@agent-desktop/client";

/**
 * Stable entry-list key. It shares the `conversations` prefix with the
 * paginated `useConversations` variants (no global query changes), with a
 * second segment keeping this full-list read distinct in the cache.
 */
export const ENTRY_CONVERSATIONS_KEY = ["conversations", { entry: "index" }] as const;

/**
 * The index entry read: every cursor page, in order, so the latest own
 * direct/room chat is found even when it sits past the default first page
 * or the first page holds only task/peer threads (the backend does not sort
 * this listing). A later-page failure rejects the whole read — the caller
 * must offer a retry and never declare a latest chat from a prefix. A
 * repeated or non-advancing cursor also rejects instead of fetching
 * forever on an inconsistent server.
 */
export async function listEntryConversations(client: ApiClient): Promise<Conversation[]> {
  const items: Conversation[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page =
      cursor === undefined
        ? await client.conversations.list({})
        : await client.conversations.list({ cursor });
    for (const item of page.items) items.push(item);
    if (page.nextCursor === null) return items;
    if (page.nextCursor === cursor || seen.has(page.nextCursor)) {
      throw new Error("Conversations paging did not advance.");
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
