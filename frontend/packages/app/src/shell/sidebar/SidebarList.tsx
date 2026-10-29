import type { Agent } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { useState } from "react";
import { StackedAvatars } from "../../components/agent/StackedAvatars";
import { ChatRow } from "../../components/agent/ChatRow";
import { useNeedsYouRequests, useRuns } from "../../data/queries";
import { t } from "../../lib/i18n";
import type { ComposeRecipient } from "../../store/ui";
import { ROW_AVATAR, ROW_RADIUS } from "./SidebarWidgets";
import { SectionHeader } from "./SidebarNav";
import { ChannelIcon, CHANNEL_PLATFORMS } from "../../components/channel/platforms";
import { CHAT_FILTERS, channelPlatformsIn, filterChatEntries, platformFilter, primaryAgentFor, type ChatEntry, type ChatFilter } from "./chatEntries";

const RECENTS_CAP = 20;
/** Chip labels: the platform's short name ("Feishu / Lark" is too long for a chip). */
const PLATFORM_SHORT: Record<string, string> = { feishu: "Feishu" };

export interface SidebarListProps {
  entries: ChatEntry[];
  activeId: string | undefined;
  collapsed: boolean;
  composeRecipients: ComposeRecipient[];
  agentById: Map<string, Agent>;
  onCompose: boolean;
  onOpen: (conversationId: string) => void;
  onOpenComputer: (conversationId: string) => void;
  onTogglePin: (entry: ChatEntry) => void;
  onMarkRead: (entry: ChatEntry) => void;
  onProfile: (agent: Agent) => void;
  onRenameEntry: (entry: ChatEntry) => void;
  onDeleteEntry: (entry: ChatEntry) => void;
  onMute: (entry: ChatEntry) => void;
  onOpenDraft: () => void;
}

/** The scrollable chat rows, with the unsent compose draft pinned above them. */
export function SidebarList({
  entries,
  activeId,
  collapsed,
  composeRecipients,
  agentById,
  onCompose,
  onOpen,
  onOpenComputer,
  onTogglePin,
  onMarkRead,
  onProfile,
  onRenameEntry,
  onDeleteEntry,
  onMute,
  onOpenDraft,
}: SidebarListProps) {
  const [filter, setFilter] = useState<ChatFilter | `platform:${string}`>("all");
  const [showAll, setShowAll] = useState(false);
  const platforms = channelPlatformsIn(entries, Object.keys(CHANNEL_PLATFORMS));
  // A platform chip whose chats are all gone falls back to All.
  const active = filter.startsWith("platform:") && !platforms.includes(filter.slice(9)) ? "all" : filter;
  const filtered = filterChatEntries(entries, active);
  // The cap is data-driven only: collapsing never changes the row count, so the
  // rows below the chrome keep the same y in both states.
  const shown = showAll ? filtered : filtered.slice(0, RECENTS_CAP);
  // Group markers only when the filtered set holds pinned rows; otherwise the
  // list stays continuous with no section headings. The cap counts rows, never
  // the markers.
  const showGroups = filtered.some((entry) => entry.conversation.pinned);
  const shownPinned = showGroups ? shown.filter((entry) => entry.conversation.pinned) : [];
  const shownOthers = showGroups ? shown.filter((entry) => !entry.conversation.pinned) : shown;
  // One keyed sequence for the single ul: heading markers interleaved with rows,
  // so pin/unpin moves the same mounted ChatRow nodes instead of remounting them.
  const nodes: Array<{ key: string; heading?: string; entry?: ChatEntry }> = [];
  if (shownPinned.length > 0) nodes.push({ key: "group-pinned", heading: t("sidebar.pinned") });
  for (const entry of shownPinned) nodes.push({ key: entry.conversation.id, entry });
  if (showGroups && shownOthers.length > 0) nodes.push({ key: "group-other", heading: t("sidebar.otherChats") });
  for (const entry of shownOthers) nodes.push({ key: entry.conversation.id, entry });
  const { data: runs } = useRuns();
  const { data: pending } = useNeedsYouRequests();
  // The chip counts pending requests (iPhone), not chats.
  const needsYouCount = pending?.length ?? entries.reduce((sum, entry) => sum + (entry.conversation.needsYou ?? 0), 0);
  const rowState = (conversationId: string) => {
    const working = runs?.find(
      (run) => run.conversationId === conversationId && !run.parentRunId && (run.status === "running" || run.status === "queued"),
    );
    const waiting = pending?.find((request) => request.conversationId === conversationId);
    return { ...(working ? { working } : {}), ...(waiting ? { waiting } : {}) };
  };
  return (
    <div
      data-slot="sidebar-list"
      className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto scrollbar-none px-2 pb-2 pt-1"
    >
      {/* The unsent compose draft stays mounted whenever it exists; collapsed it
          fades to its avatar only (same row height), so the rows below keep y. */}
      {composeRecipients.length > 0 && (
        <button
          type="button"
          onClick={onOpenDraft}
          aria-label={collapsed ? t("compose.draftTitle") : undefined}
          className={cn(
            "mb-0.5 flex w-full min-w-0 items-center gap-2 overflow-hidden px-2 py-1.5 text-left transition-colors",
            ROW_RADIUS,
            onCompose ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            "focus-ring",
          )}
        >
          <span className="chat-row-avatar flex size-10 shrink-0 items-center justify-center">
            {composeRecipients.some((r) => r.agentId) ? (
              <StackedAvatars
                agents={composeRecipients.flatMap((r) =>
                  r.agentId ? (agentById.get(r.agentId) ? [agentById.get(r.agentId)!] : []) : [],
                )}
                slot={40}
              />
            ) : (
              <span className={cn(ROW_AVATAR, "rounded-full bg-fg/15")} />
            )}
          </span>
          <span
            aria-hidden={collapsed || undefined}
            className={cn(
              "chat-row-text flex min-w-0 flex-1 flex-col overflow-hidden",
              collapsed && "pointer-events-none opacity-0",
            )}
          >
            <span className="truncate text-base font-semibold text-fg">
              {t("compose.draftTitle")}
            </span>
            <span className="truncate text-sm text-fg-muted">
              {composeRecipients.map((r) => r.name).join(", ")}
            </span>
          </span>
        </button>
      )}
      {/* Filter chrome: full readable labels, sized once to the saved expanded width
          so the layout never changes while the rail narrows. Collapsing folds its
          height away on the shared grid clock while it fades and clips. */}
      <div
        data-slot="sidebar-recents-chrome"
        className="collapse-rows shrink-0"
        data-closed={collapsed ? "true" : undefined}
      >
        <div inert={collapsed || undefined} aria-hidden={collapsed || undefined}>
          {/* No hairline under the search row (owner request 2026-10-17): the navigation it
              used to separate is in the icon rail now, so the line reads as a stray border. */}
          <div className="sidebar-chrome-content pt-2">
            {/* Filter pills sit on the list's surface edge (px-0), so their pill and the
                search field share one left gutter. One row of four, like the phone's chip
                strip; the row wraps instead of clipping when the panel is narrow. */}
            <div
              role="group"
              aria-label={t("sidebar.chatFilters")}
              className="sidebar-filter-chips flex flex-wrap items-center gap-1.5 px-0 pb-1.5 pt-0.5"
            >
              {CHAT_FILTERS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active === key}
                  tabIndex={collapsed ? -1 : undefined}
                  onClick={() => {
                    setFilter(key);
                    setShowAll(false);
                  }}
                  className={cn(
                    // The four labels need 157px of text; px-1 and a 6px gap fit the row in
                    // the narrowest panel (213px of chrome). A narrower panel wraps the row
                    // rather than clipping it.
                    "flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1 text-xs transition-colors focus-ring",
                    active === key ? "bg-sidebar-accent font-medium text-fg" : "text-fg-muted hover:bg-sidebar-accent/60",
                  )}
                >
                  {t(`chatList.filter.${key}`)}
                  {key === "needsYou" && needsYouCount > 0 && (
                    <span className="shrink-0 rounded-full bg-warning px-1 text-[11px] font-semibold leading-4 text-primary-foreground">
                      {needsYouCount > 99 ? "99+" : needsYouCount}
                    </span>
                  )}
                </button>
              ))}
              {/* One chip per messaging platform that has chats: brand icon + short name. */}
              {platforms.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={active === platformFilter(kind)}
                  tabIndex={collapsed ? -1 : undefined}
                  onClick={() => {
                    setFilter(platformFilter(kind));
                    setShowAll(false);
                  }}
                  className={cn(
                    "flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1 text-xs transition-colors focus-ring",
                    active === platformFilter(kind) ? "bg-sidebar-accent font-medium text-fg" : "text-fg-muted hover:bg-sidebar-accent/60",
                  )}
                >
                  <ChannelIcon kind={kind} className="size-3.5" />
                  {PLATFORM_SHORT[kind] ?? CHANNEL_PLATFORMS[kind]?.name ?? kind}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-fg-subtle">{t("common.empty")}</p>
      ) : (
        <ul data-slot="sidebar-recents" className="flex flex-col gap-0.5">
          {nodes.map((node) => {
            // Group headings ride the same collapse/fade clock as the filter chrome:
            // open when expanded, folded away with no ghost gap on the rail.
            if (node.entry === undefined) {
              return (
                <li
                  key={node.key}
                  data-slot="sidebar-group-heading"
                  className="collapse-rows"
                  data-closed={collapsed ? "true" : undefined}
                >
                  <div inert={collapsed || undefined} aria-hidden={collapsed || undefined}>
                    <SectionHeader title={node.heading ?? ""} />
                  </div>
                </li>
              );
            }
            const entry = node.entry;
            const agent = primaryAgentFor(entry);
            return (
              <li key={entry.conversation.id}>
                <ChatRow
                  conversation={entry.conversation}
                  agents={entry.agents}
                  active={entry.conversation.id === activeId}
                  collapsed={collapsed}
                  {...rowState(entry.conversation.id)}
                  onOpen={() => onOpen(entry.conversation.id)}
                  onOpenComputer={() => onOpenComputer(entry.conversation.id)}
                  onPin={() => onTogglePin(entry)}
                  onMute={() => onMute(entry)}
                  onMarkRead={() => onMarkRead(entry)}
                  onDelete={() => onDeleteEntry(entry)}
                  {...(agent
                    ? { onRename: () => onRenameEntry(entry), onProfile: () => onProfile(agent) }
                    : {})}
                />
              </li>
            );
          })}
        </ul>
      )}
      {filtered.length > RECENTS_CAP && (
        <button
          type="button"
          inert={collapsed || undefined}
          aria-hidden={collapsed || undefined}
          tabIndex={collapsed ? -1 : undefined}
          onClick={() => setShowAll((value) => !value)}
          className={cn(
            "sidebar-fade w-full min-w-0 truncate px-2 py-1.5 text-left text-xs text-fg-subtle transition-colors hover:text-fg focus-ring",
            collapsed && "pointer-events-none opacity-0",
          )}
        >
          {showAll ? t("chatList.showLess") : t("chatList.showMore")}
        </button>
      )}
    </div>
  );
}
