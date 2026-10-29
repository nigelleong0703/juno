import type { ArtifactItem } from "../../lib/items";
import { Button, cn } from "@agent-desktop/ui";
import { useQuery } from "@tanstack/react-query";
import { ArtifactCell } from "../artifact/ArtifactCell";
import { useOpenArtifact } from "../artifact/useOpenArtifact";
import { useSpaces } from "../../data/spaces";
import { useClient } from "../../data/ClientProvider";
import { useAgents } from "../../data/queries";

export interface ArtifactItemProps {
  item: ArtifactItem;
  className?: string;
}

/**
 * A produced file in the transcript: its thumbnail, name and "<agent> · <time>" under it. Tapping it opens the
 * full-screen viewer (`/library/:id`), the same one the Library uses. No border, no inline preview.
 */
export function ArtifactItem({ item, className }: ArtifactItemProps) {
  const client = useClient();
  const { open } = useOpenArtifact();
  const { data: agents } = useAgents();
  const spaces = useSpaces();
  const artifactQuery = useQuery({
    queryKey: ["artifact", item.artifactId],
    queryFn: () => client.library.get(item.artifactId),
    retry: false,
  });
  const artifact = artifactQuery.data;

  if (artifactQuery.isLoading) {
    return (
      <div className={cn("py-1", className)}>
        <div className="flex w-[260px] max-w-full flex-col gap-2">
          <span className="aspect-[4/3] w-full animate-pulse rounded-lg bg-muted" />
          <span className="text-xs text-fg-subtle">Loading file…</span>
        </div>
      </div>
    );
  }

  if (artifactQuery.isError || !artifact) {
    return (
      <div className={cn("py-1", className)}>
        <div className="flex items-center gap-3 px-1 py-2">
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg">File unavailable</span>
            <span className="text-xs text-fg-subtle">Couldn't load this file.</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void artifactQuery.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const agentName = artifact.createdByAgentId ? agents?.find((agent) => agent.id === artifact.createdByAgentId)?.name : undefined;
  const spaceStatus = artifact.spaceId ? spaces.data?.items.find((space) => space.id === artifact.spaceId)?.status : undefined;
  return (
    <div className={cn("py-1", className)}>
      <ArtifactCell item={artifact} agentName={agentName} spaceStatus={spaceStatus} onOpen={() => open(artifact.id)} className="w-[260px] max-w-full" />
    </div>
  );
}
