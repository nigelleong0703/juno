import type { LibraryItem } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";

/** Library mutations (§4.11): pin / unpin and delete a file. */
export function useSetLibraryPinned() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      client.library.setPinned(id, pinned),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["library"] }),
  });
}

export function useDeleteLibraryItem() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.library.delete(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["library"] }),
  });
}

const AGENT_LIBRARY_PAGES = 10;

/**
 * Everything agents made for the user (not uploads), across all chats: reads cursor pages until the
 * list ends, at most {@link AGENT_LIBRARY_PAGES} pages so a huge library cannot stall the page.
 * Shares the `library` key prefix, so pin/delete refresh it.
 */
export function useAgentLibrary() {
  const client = useClient();
  return useQuery({
    queryKey: ["library", "agent-made"] as const,
    queryFn: async () => {
      const items: LibraryItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < AGENT_LIBRARY_PAGES; page += 1) {
        const result = await client.library.list(cursor ? { source: "agent", limit: 100, cursor } : { source: "agent", limit: 100 });
        items.push(...result.items.filter((item) => item.source === "agent"));
        if (!result.nextCursor || result.nextCursor === cursor) break;
        cursor = result.nextCursor;
      }
      return items;
    },
  });
}
