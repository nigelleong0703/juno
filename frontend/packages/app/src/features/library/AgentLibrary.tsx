import type { LibraryItem } from "@agent-desktop/client";
import { EmptyState, ErrorState, LoadingState, ScrollArea, SearchField, SegmentedControl } from "@agent-desktop/ui";
import { useMemo, useState, type ReactNode } from "react";
import { AgentScopeButton } from "../../components/agent/AgentScopeButton";
import { ArtifactCell } from "../../components/artifact/ArtifactCell";
import { filterLibrary, LIBRARY_FILTERS, type LibraryFilter } from "../../components/artifact/artifactKind";
import { useOpenArtifact } from "../../components/artifact/useOpenArtifact";
import { PageFrame } from "../../components/page/PageFrame";
import { useAgentLibrary } from "../../data/library";
import { useAgents } from "../../data/queries";
import { useSpaces } from "../../data/spaces";
import { t } from "../../lib/i18n";

const FILTER_LABEL: Record<LibraryFilter, string> = {
  all: "library.all",
  pages: "library.pages",
  files: "library.files",
  spaces: "library.spaces",
  shared: "library.sharedTab",
};

/**
 * The Library (owner-approved 2026-10-27): what agents made for you as a grid of thumbnails. Search, the category
 * control (All · Pages · Files · Spaces · Shared) and the agent scope sit above it. Opening an item goes straight to the
 * full-screen viewer at `/library/:id`; the thumbnails load only as their cells scroll into view.
 */
export function AgentLibrary() {
  const { open } = useOpenArtifact();
  const [query, setQuery] = useState("");
  const [agentId, setAgentId] = useState("all");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const library = useAgentLibrary();
  const { data: agents } = useAgents();
  const spaces = useSpaces();
  const spaceList = useMemo(() => spaces.data?.items ?? [], [spaces.data]);
  const spaceStatus = useMemo(() => new Map(spaceList.map((space) => [space.id, space.status])), [spaceList]);
  const hostedSpaceIds = useMemo(() => new Set(spaceList.filter((space) => space.hosted).map((space) => space.id)), [spaceList]);
  const items = useMemo(
    () => filterLibrary(library.data ?? [], { filter, query, agentId, hostedSpaceIds }),
    [library.data, filter, query, agentId, hostedSpaceIds],
  );
  const agentName = (id: string | undefined) => (id ? agents?.find((agent) => agent.id === id)?.name : undefined);
  const narrowed = query.trim().length > 0 || filter !== "all";

  let body: ReactNode;
  if (library.isLoading) {
    body = <LoadingState label={t("common.loading")} />;
  } else if (library.isError) {
    body = <ErrorState title={t("common.error")} onRetry={() => void library.refetch()} />;
  } else if (items.length === 0) {
    body = <EmptyState title={narrowed ? t("library.noMatch") : t("library.empty")} description={narrowed ? undefined : t("library.emptyHint")} />;
  } else {
    body = (
      <div data-slot="library-grid" className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((item: LibraryItem) => (
          <ArtifactCell
            key={item.id}
            item={item}
            agentName={agentName(item.createdByAgentId)}
            spaceStatus={item.spaceId ? spaceStatus.get(item.spaceId) : undefined}
            onOpen={() => open(item.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <PageFrame fullWidth title={t("library.title")} scope={<AgentScopeButton bubble agents={agents} value={agentId} onChange={setAgentId} />}>
      <div className="flex flex-wrap items-center gap-3 px-5 pb-4">
        <SearchField className="w-60" size="sm" value={query} onValueChange={setQuery} placeholder={t("library.search")} />
        <SegmentedControl
          aria-label={t("library.filter")}
          value={filter}
          onValueChange={(value) => setFilter(value as LibraryFilter)}
          items={LIBRARY_FILTERS.map((option) => ({ value: option, label: t(FILTER_LABEL[option]) }))}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-6xl px-5 pb-10">{body}</div>
      </ScrollArea>
    </PageFrame>
  );
}
