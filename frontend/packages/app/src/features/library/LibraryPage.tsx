import { useQuery } from "@tanstack/react-query";
import { Button, EmptyState } from "@agent-desktop/ui";
import { ChevronLeft, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ArtifactViewer } from "../../components/artifact/ArtifactViewer";
import { useOpenArtifact } from "../../components/artifact/useOpenArtifact";
import { ConversationFilesPanel } from "../../components/chat-files";
import { PageAction, PageFrame } from "../../components/page/PageFrame";
import { useClient } from "../../data/ClientProvider";
import { useAgentLibrary } from "../../data/library";
import { useAgents } from "../../data/queries";
import { AgentLibrary } from "./AgentLibrary";

/**
 * Library route adapter. Without a conversation scope it is the Library (`AgentLibrary`: the agent-made grid). With one
 * it is the chat's files: every artifact agents produced or you uploaded in that conversation.
 *
 * Scope comes from the explicit `conversationId` prop (the computer column passes the open chat) and falls back to the
 * `?conversationId=ID` query param. `/library/:fileId` opens the full-screen viewer of one item over the page
 * (`ArtifactViewer`), from every entry point; closing it goes back. `embedded` drops the page header (the computer
 * column already has one).
 *
 * All query/filter/list logic lives in the feature components; this file is only the route.
 */
export interface LibraryPageProps {
  /** Explicit conversation scope; wins over the `?conversationId=` query param. */
  conversationId?: string;
  /** Embedded in the computer column: no page header. */
  embedded?: boolean;
}

export function LibraryPage({ conversationId: explicitScope, embedded = false }: LibraryPageProps = {}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { fileId } = useParams();
  const { close } = useOpenArtifact();
  const [scopedCount, setScopedCount] = useState(0);

  const rawScope = searchParams.get("conversationId") ?? undefined;
  const queryScope = rawScope && rawScope.length > 0 ? rawScope : undefined;
  const fileScope = explicitScope && explicitScope.length > 0 ? explicitScope : queryScope;
  const global = !embedded && !fileScope;

  let page: ReactNode;
  if (global) {
    page = <AgentLibrary />;
  } else {
    const panel = <ConversationFilesPanel conversationId={fileScope ?? ""} onScopedCountChange={setScopedCount} />;
    page = embedded ? (
      <div className="flex h-full min-h-0 flex-col bg-bg">{panel}</div>
    ) : (
      <PageFrame
        title="Chat files"
        back={fileScope ? <PageAction icon={ChevronLeft} label="Back to chat" onClick={() => navigate(`/c/${fileScope}`)} /> : undefined}
        actions={fileScope ? <span className="text-[13px] text-fg-muted">{scopedCount} items</span> : undefined}
      >
        {panel}
      </PageFrame>
    );
  }

  return (
    <>
      {page}
      {fileId ? <ArtifactViewerRoute id={fileId} onClose={close} /> : null}
    </>
  );
}

/** The viewer of one item by id. The Library's list supplies it at once when it is loaded; the item is fetched otherwise. */
function ArtifactViewerRoute({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useClient();
  const library = useAgentLibrary();
  const { data: agents } = useAgents();
  const fromList = library.data?.find((item) => item.id === id);
  const fetched = useQuery({
    queryKey: ["library", "item", id],
    queryFn: () => client.library.get(id),
    retry: false,
    enabled: !fromList,
  });
  const item = fromList ?? fetched.data;
  if (!item) {
    return (
      <div role="status" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-bg p-6 text-center">
        {fetched.isError ? (
          <EmptyState title="This file is no longer here" description="It may have been deleted." />
        ) : (
          <Loader2 aria-label="Loading" className="size-5 animate-spin text-fg-subtle" />
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
    );
  }
  return <ArtifactViewer item={item} agentName={item.createdByAgentId ? agents?.find((agent) => agent.id === item.createdByAgentId)?.name : undefined} onClose={onClose} />;
}
