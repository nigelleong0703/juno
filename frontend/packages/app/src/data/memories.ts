import type { MemoryClaim } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/** Every claim the agents distilled about the user (newest first); `agent.home.changed` on a memory file refetches them. */
export function useMemoryClaims() {
  const client = useClient();
  return useQuery({ queryKey: qk.memoryClaims(), queryFn: async (): Promise<MemoryClaim[]> => (await client.memory.claims()).claims });
}

/** Ranked chunks of the memory files matching `query` (empty query: disabled). */
export function useMemorySearch(query: string) {
  const client = useClient();
  return useQuery({
    queryKey: qk.memorySearch(query),
    queryFn: async () => (await client.memory.search(query)).hits,
    enabled: query.length > 0,
  });
}

/** Retract claims and remove their lines from the memory files; refetches claims and files. */
export function useForgetMemory() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (claimIds: string[]) => client.memory.forget({ claimIds }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["memory"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });
}
