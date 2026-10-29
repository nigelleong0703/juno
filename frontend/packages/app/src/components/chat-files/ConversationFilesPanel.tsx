import {
  Combobox,
  EmptyState,
  ErrorState,
  FileIcon,
  LoadingState,
  RelativeTime,
  ScrollArea,
  SearchField,
  SegmentedControl,
} from "@agent-desktop/ui";
import {
  FileText,
  LayoutGrid,
  Pin,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ArtifactCell } from "../artifact/ArtifactCell";
import { useOpenArtifact } from "../artifact/useOpenArtifact";
import { useSpaces } from "../../data/spaces";
import { useAgents, useConversation, useLibrary } from "../../data/queries";
import { formatBytes } from "../../lib/format";
import { t } from "../../lib/i18n";
import { fileFormat } from "../conversation/artifactPreview";

type View = "grid" | "list";

export interface ConversationFilesPanelProps {
  /** Explicit conversation scope; the panel lists only this conversation's files. */
  conversationId: string;
  /** Reports the scoped file total for route chrome (e.g. the page header subtitle). */
  onScopedCountChange?: (count: number) => void;
}

/**
 * Conversation-scoped files panel (CX-chat-files): lists only the given conversation's
 * files — agent-delivered and uploaded alike — never a global list. Opening a file goes to
 * the full-screen viewer (`/library/:id`), the same one the Library uses.
 */
export function ConversationFilesPanel({ conversationId, onScopedCountChange }: ConversationFilesPanelProps) {
  const { open } = useOpenArtifact();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("grid");
  // {scope, value} keeps the picked agent tied to the chat it was picked in, so
  // another conversation's selection can never leak into this one's first render.
  const [agentFilter, setAgentFilter] = useState<{ scope: string; value: string }>({ scope: "", value: "all" });

  const scope = conversationId.length > 0 ? conversationId : undefined;
  const {
    data: library,
    isLoading,
    isError,
    refetch,
  } = useLibrary({ conversationId: scope }, Boolean(scope));
  const { data: agents } = useAgents();
  const spaces = useSpaces();
  const { data: conversation } = useConversation(scope);

  // Authoritative membership comes from the conversation itself (schema kind
  // direct|room|task|peer). Only room conversations show the agent filter, and
  // its options are limited to the current conversation's agentIds. Account
  // agents stay in use for author labels only — never as filter options.
  const isGroup = conversation?.kind === "room" && conversation.id === scope;
  const memberIds = useMemo(() => (isGroup ? conversation.agentIds : []), [conversation, isGroup]);
  const memberAgents = useMemo(
    () => (agents ?? []).filter((agent) => memberIds.includes(agent.id)),
    [agents, memberIds],
  );

  // Ignore a stale selection until the reset effect clears it, so a filter from
  // another chat (or a removed member) never screens this conversation's files.
  const effectiveFilter = isGroup && agentFilter.scope === scope && agentFilter.value !== "all" && memberIds.includes(agentFilter.value) ? agentFilter.value : "all";

  useEffect(() => {
    setAgentFilter({ scope: "", value: "all" });
  }, [scope]);

  useEffect(() => {
    if (agentFilter.value !== "all" && (!isGroup || !memberIds.includes(agentFilter.value))) setAgentFilter({ scope: "", value: "all" });
  }, [agentFilter, isGroup, memberIds]);

  // Defensive front filter to go with the server-side scope: strict conversationId
  // equality, and no rows at all without a scope.
  const scoped = useMemo(
    () => (scope ? (library ?? []).filter((item) => item.conversationId === scope) : []),
    [library, scope],
  );

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scoped.filter((item) => {
      if (effectiveFilter !== "all" && item.createdByAgentId !== effectiveFilter) return false;
      if (!needle) return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        item.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [scoped, effectiveFilter, query]);

  const agentFor = (id: string | undefined) => (id ? agents?.find((agent) => agent.id === id) : undefined);
  const spaceStatus = new Map((spaces.data?.items ?? []).map((space) => [space.id, space.status]));

  useEffect(() => {
    onScopedCountChange?.(scoped.length);
  }, [scoped.length, onScopedCountChange]);

  const showAgentFilter = isGroup === true;
  const isUnfiltered = query.trim() === "" && effectiveFilter === "all";
  // Unfiltered scoped empty after a successful load: hide the filter toolbar so the
  // panel is a compact top-anchored row instead of a huge blank canvas. Filtered-zero,
  // loading and error keep the toolbar and their own states.
  const hideToolbar =
    Boolean(scope) && !isLoading && !isError && scoped.length === 0 && isUnfiltered;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      {hideToolbar ? null : (
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <SearchField
          className="w-60"
          size="sm"
          value={query}
          onValueChange={setQuery}
          placeholder="Search files…"
        />
        {showAgentFilter ? (
          <Combobox
            className="h-8 w-44 text-sm"
            value={effectiveFilter}
            onValueChange={(value) => setAgentFilter({ scope, value })}
            placeholder="Every agent"
            searchPlaceholder="Find an agent…"
            options={[
              { value: "all", label: "Every agent" },
              ...memberAgents.map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
          />
        ) : null}
        <div className="ml-auto">
          <SegmentedControl
            aria-label="View"
            value={view}
            onValueChange={(value) => {
              if (value === "grid" || value === "list") setView(value);
            }}
            items={[
              { value: "grid", label: "Grid", icon: <LayoutGrid className="size-3.5" /> },
              { value: "list", label: "List", icon: <FileText className="size-3.5" /> },
            ]}
          />
        </div>
      </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl px-5 pb-10">
          {!scope ? (
            <EmptyState centered
              title="Select a chat to see its files"
              description="Files belong to one conversation — open a chat and follow its Files entry."
            />
          ) : isLoading ? (
            <LoadingState label={t("common.loading")} />
          ) : isError ? (
            <ErrorState title={t("common.error")} onRetry={() => void refetch()} />
          ) : items.length === 0 ? (
            <EmptyState centered
              title="No files in this chat"
              description="Files shared in this conversation will show up here."
            />
          ) : view === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 pt-1">
              {items.map((item) => {
                const agent = agentFor(item.createdByAgentId);
                return (
                  <ArtifactCell
                    key={item.id}
                    item={item}
                    agentName={agent?.name}
                    spaceStatus={item.spaceId ? spaceStatus.get(item.spaceId) : undefined}
                    onOpen={() => open(item.id)}
                  />
                );
              })}
            </div>
          ) : (
            <ul className="pt-1">
              {items.map((item) => {
                const agent = agentFor(item.createdByAgentId);
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-interactive-hover active:bg-interactive-pressed"
                  >
                    <button
                      type="button"
                      onClick={() => open(item.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-fg-muted">
                        <FileIcon name={item.name} size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-fg" title={item.name}>{item.name}</span>
                          {item.pinned && <Pin className="size-3 shrink-0 text-fg-subtle" />}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                          {formatBytes(item.sizeBytes)} · {fileFormat(item.name)}
                          {agent ? ` · ${agent.name}` : item.source === "upload" ? " · You" : ""}
                        </span>
                      </span>
                    </button>
                    <RelativeTime date={item.updatedAt} className="shrink-0 text-xs text-fg-subtle" />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
