import { useQuery } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";

/** The owner's Spaces (agent-built apps). The Library's Shared tab lists the ones with a hosted link. */
export function useSpaces() {
  const client = useClient();
  return useQuery({ queryKey: ["spaces", "list"], queryFn: () => client.spaces.list() });
}
