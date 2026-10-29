import { useEffect, useState } from "react";
import type { Agent, Conversation, Item, Request, Run } from "@agent-desktop/client";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@agent-desktop/ui";
import { BellOff, CheckCheck, Pencil, Pin, PinOff, Trash2, UserRound, Volume2, VolumeX } from "lucide-react";
import { useItems } from "../../data/queries";
import { formatChatTime } from "../../lib/format";
import { t } from "../../lib/i18n";
import { splitQuote } from "../../lib/quote";
import { needText, runStatusText } from "../../lib/stepLine";
import { ChannelBadge } from "../channel/platforms";
import { AgentAvatar } from "./AgentAvatar";
import { StackedAvatars } from "./StackedAvatars";

/** Sidebar row radius, shared with the sidebar's own rows (design-system token). */
const ROW_RADIUS = "rounded-[var(--radius-md)]";

/** How far back a row looks for its subtitle before falling back to the stored preview. */
const SUMMARY_SCAN = 30;

/**
 * The newest user/agent message text in already-fetched items, scanning
 * newest-first so a trailing run, plan, request or system item can never
 * become the subtitle. Returns undefined when nothing in range is a message.
 */
export function latestMessageSummary(items: readonly Item[]): string | undefined {
  const start = Math.max(0, items.length - SUMMARY_SCAN);
  for (let index = items.length - 1; index >= start; index--) {
    const item = items[index];
    if (!item) continue;
    // A reply's leading "> quote" block is the quoted message, not what was said: preview the reply itself.
    if (item.type === "user_message" && item.text.trim().length > 0) return splitQuote(item.text).body.trim() || item.text;
    if (item.type === "agent_message") {
      const first = splitQuote(item.markdown).body.split("\n").find((line) => line.trim().length > 0);
      if (first !== undefined) return first;
    }
  }
  return undefined;
}

/** " · <what it is doing>" for the green subtitle; nothing when the run has no readable step yet. */
function taskLine(run: Run): string {
  const line = runStatusText(run, undefined).replace(/…$/, "");
  return line === "Working" ? "" : ` · ${line}`;
}

export interface ChatRowProps {
  conversation: Conversation;
  /** The agent for a direct chat; the participants for a room. */
  agents: Agent[];
  active?: boolean;
  /** Collapsed rail: the same row clipped to its avatar (text fades, tooltip shows the name). */
  collapsed?: boolean;
  /**
   * Legacy collapse-animation flag, ignored for geometry. The row follows `collapsed`
   * alone so the highlight always fits the live track width with one interruptible
   * CSS transition; kept so existing callers keep typechecking.
   */
  animating?: boolean;
  /** The conversation's running top-level run: the row reads "Working · <task line>" and the avatar shows the green dot. */
  working?: Run;
  /** The oldest pending request in the conversation: the row reads "Needs you: <what>". */
  waiting?: Request;
  onOpen: () => void;
  /**
   * Opens the agent's computer for this conversation (the red dot is its own
   * button, separate from the row that selects the chat). Falls back to
   * `onOpen` when not given.
   */
  onOpenComputer?: () => void;
  onPin?: () => void;
  onRename?: () => void;
  onMute?: () => void;
  onMarkRead?: () => void;
  onProfile?: () => void;
  onDelete?: () => void;
}

/**
 * One chat-list row (VISUAL.md "Sidebar chat rows", after the iPhone list): 40px avatar (green dot while
 * a run works), name + muted bell + right-aligned time, a two-line subtitle ("Working · task" in green,
 * "Needs you: what" in amber, else the message preview), a pin glyph and a numeric unread badge.
 * Rooms stack their participants' avatars.
 * This is the single row used for both agents and group chats.
 */
export function ChatRow({
  conversation,
  agents,
  active,
  collapsed = false,
  working,
  waiting,
  onOpen,
  onOpenComputer,
  onPin,
  onRename,
  onMute,
  onMarkRead,
  onProfile,
  onDelete,
}: ChatRowProps) {
  const isGroup = conversation.kind === "room" || conversation.kind === "peer";
  const primary = agents[0];
  const fallback = isGroup
    ? agents.map((agent) => agent.name).join(", ") || undefined
    : primary?.name;
  const name = conversation.title ?? fallback ?? t("chat.untitled");
  const needsYou = conversation.needsYou ?? 0;
  const unread = conversation.unreadCount;

  // The subtitle is the latest user/agent message summary resolved from items; the stored preview is
  // only a fallback (it is derived from the last item of any kind). While a run works or a request
  // waits, the iPhone's task line wins, worded by the same helpers as the status pill.
  const { data: items } = useItems(conversation.id);
  // Tooltip open state lives here so `open` is always a controlled boolean: the
  // previous `collapsed ? undefined : false` flipped between controlled and
  // uncontrolled across the collapse and logged a React warning mid-transition.
  const [tipOpen, setTipOpen] = useState(false);
  // A hover made while the list was expanded must not surface as a stuck bubble once it collapses.
  useEffect(() => setTipOpen(false), [collapsed]);
  const preview =
    (items && latestMessageSummary(items)) ?? conversation.lastMessagePreview ?? "";

  const subtitle = working
    ? { text: `● ${t("chatRow.working")}${taskLine(working)}`, className: "text-success" }
    : waiting
      ? { text: `${t("chatRow.needsYou")}: ${needText(waiting)}`, className: "text-warning" }
      : { text: preview, className: unread > 0 || needsYou > 0 ? "text-fg-muted" : "text-fg-subtle" };

  // Collapsed rail: one red dot per avatar (pending requests or unread messages) at its top-right
  // corner; the expanded row shows the numeric badge instead.
  const railDot = needsYou > 0 || unread > 0 ? "bg-danger" : null;

  /**
   * One layout for the list and the rail (owner feedback 2026-10-05): the 40px avatar slot never
   * moves or resizes; collapsing narrows the row's highlight to the 68px rail tile and fades the
   * text column out.
   *
   * The red dot is its own button, split from the row that selects the chat: with pending
   * requests it opens the agent's computer, never just the chat. Sibling buttons, never
   * nested, so both stay keyboard-operable; the dot carries no visible count.
   */
  const openComputer = onOpenComputer ?? onOpen;
  const showNeedsYouDot = !collapsed && needsYou > 0;

  const row = (
    <div
      data-slot="chat-row"
      data-active={active ? "true" : undefined}
      data-collapsed={collapsed ? "true" : undefined}
      className={cn(
        "chat-row relative flex w-full min-w-0 items-center gap-2",
        ROW_RADIUS,
        "transition-[background-color] duration-200 ease-[var(--ease-panel)]",
        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? name : undefined}
        className="chat-row-button flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left focus-ring"
      >
      <span data-slot="chat-row-avatar" className="chat-row-avatar relative flex size-10 shrink-0 items-center justify-center">
        {isGroup ? (
          <StackedAvatars agents={agents} slot={40} label={name} />
        ) : primary ? (
          <AgentAvatar
            agentId={primary.id}
            avatar={primary.avatar}
            status={collapsed && railDot ? undefined : working ? "working" : primary.status}
            size={40}
            label={name}
            dotRingClassName="ring-sidebar"
          />
        ) : null}
        {railDot && (
          <span
            aria-hidden
            className={cn(
              "absolute right-0 top-0 size-2.5 rounded-full ring-2 ring-sidebar transition-opacity duration-150",
              railDot,
              collapsed ? "opacity-100" : "opacity-0",
            )}
          />
        )}
      </span>

      <span
        data-slot="chat-row-text"
        aria-hidden={collapsed || undefined}
        className={cn(
          "chat-row-text flex min-w-0 flex-1 flex-col",
          collapsed && "pointer-events-none opacity-0",
        )}
      >
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate text-base font-semibold text-fg">{name}</span>
          {conversation.channel && <ChannelBadge kind={conversation.channel.kind} iconOnly className="self-center" />}
          {conversation.muted && <BellOff aria-label={t("chatList.unmute")} className="size-3 shrink-0 self-center text-fg-subtle" />}
          <span className={cn("ml-auto shrink-0 text-xs", unread > 0 ? "text-fg" : "text-fg-subtle/80")}>
            {formatChatTime(conversation.lastItemAt)}
          </span>
        </span>
        <span className="flex items-start gap-2">
          <span data-slot="chat-row-subtitle" className={cn("line-clamp-2 min-w-0 flex-1 text-xs", subtitle.className)}>
            {subtitle.text || " "}
          </span>
          {conversation.pinned && <Pin aria-label={t("chatList.pin")} className="mt-0.5 size-3 shrink-0 text-fg-subtle" />}
          {unread > 0 && (
            <span
              data-testid="chat-row-unread-badge"
              className={cn(
                "flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold text-primary-foreground",
                conversation.muted ? "bg-fg-subtle" : "bg-primary",
              )}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </span>
      </span>
      </button>
      {/* Overlays the avatar's upper-right corner (40px avatar at the button's 8px/6px
          padding): the same spot as the static dot below. No visible count. */}
      {showNeedsYouDot && (
        <button
          type="button"
          onClick={openComputer}
          aria-label={t("sidebar.needsYou")}
          title={t("chat.computer.show")}
          data-testid="chat-row-needs-you"
          className="absolute left-11 top-0.5 size-2.5 rounded-full bg-danger ring-2 ring-sidebar transition-opacity hover:brightness-110 focus-ring"
        />
      )}
    </div>
  );

  return (
    <ContextMenu>
      <TooltipProvider>
        <Tooltip open={collapsed ? tipOpen : false} onOpenChange={(next) => setTipOpen(collapsed && next)}>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>{row}</TooltipTrigger>
          </ContextMenuTrigger>
          <TooltipContent side="right">{name}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <ContextMenuContent className="w-44">
        {onPin && (
          <ContextMenuItem onSelect={onPin}>
            {conversation.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {conversation.pinned ? t("chatList.unpin") : t("chatList.pin")}
          </ContextMenuItem>
        )}
        {onRename && (
          <ContextMenuItem onSelect={onRename}>
            <Pencil className="size-4" />
            {t("chatList.rename")}
          </ContextMenuItem>
        )}
        {onMarkRead && unread > 0 && (
          <ContextMenuItem onSelect={onMarkRead}>
            <CheckCheck className="size-4" />
            {t("chatList.markRead")}
          </ContextMenuItem>
        )}
        {onMute && (
          <ContextMenuItem onSelect={onMute}>
            {conversation.muted ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            {conversation.muted ? t("chatList.unmute") : t("chatList.mute")}
          </ContextMenuItem>
        )}
        {onProfile && (
          <ContextMenuItem onSelect={onProfile}>
            <UserRound className="size-4" />
            {t("chatList.profile")}
          </ContextMenuItem>
        )}
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="size-4" />
              {t("chatList.delete")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
