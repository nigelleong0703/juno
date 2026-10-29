import type { AgentHomeFile } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/** The user's /juno home files under a path prefix; `agent.home.changed` refetches them (liveSync). */
export function useHomeFiles(prefix: string) {
  const client = useClient();
  return useQuery({ queryKey: qk.home(prefix), queryFn: async () => (await client.home.list(prefix)).files });
}

/** One home file by exact path, or `undefined` once loaded and absent. */
export function useHomeFile(path: string) {
  const query = useHomeFiles(path);
  return { ...query, file: query.data?.find((f) => f.path === path) };
}

/** Save a home file, optionally guarded by the hash it was loaded with. */
export function useWriteHomeFile() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content, expectedHash }: { path: string; content: string; expectedHash?: string }): Promise<AgentHomeFile> =>
      client.home.write(path, expectedHash === undefined ? { content } : { content, expectedHash }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["home"] }),
  });
}
