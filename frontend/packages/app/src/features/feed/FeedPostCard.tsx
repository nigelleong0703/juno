import type { Agent, FeedPost } from "@agent-desktop/client";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from "@agent-desktop/ui";
import { ExternalLink, Forward, Heart, MessageSquare, MoreHorizontal, ThumbsDown } from "lucide-react";
import { useState } from "react";
import { CARD_INTERACTIVE, CARD_SELECTED, CARD_SURFACE } from "../../components/page/PageFrame";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { formatAgo } from "../../lib/format";
import { t } from "../../lib/i18n";
import { cardSummary } from "./cardSummary";

/** The actions in a post's "…" and right-click menus, in iPhone's order. */
export interface FeedPostActions {
  onReply?: (() => void) | undefined;
  onForward: () => void;
  onOpenSource?: (() => void) | undefined;
  onDecline: () => void;
}

/** Both menus list the same actions; `Item` is the dropdown or the context-menu item. */
function menuItems(actions: FeedPostActions, Item: typeof DropdownMenuItem | typeof ContextMenuItem) {
  return (
    <>
      {actions.onReply ? (
        <Item onSelect={actions.onReply}>
          <MessageSquare className="size-4" />
          {t("feed.reply")}
        </Item>
      ) : null}
      <Item onSelect={actions.onForward}>
        <Forward className="size-4" />
        {t("feed.forward")}
      </Item>
      {actions.onOpenSource ? (
        <Item onSelect={actions.onOpenSource}>
          <ExternalLink className="size-4" />
          {t("feed.openSource")}
        </Item>
      ) : null}
      <Item variant="destructive" onSelect={actions.onDecline}>
        <ThumbsDown className="size-4" />
        {t("feed.notInterested")}
      </Item>
    </>
  );
}

/**
 * One feed post as iPhone's compact card: agent avatar, name and time, the title, a two-line summary and a square
 * thumbnail. Tapping opens the post; "…" or a right-click offers Reply, Forward…, Open source and Not interested.
 */
export function FeedPostCard({
  post,
  agent,
  actions,
  onOpen,
  onLike,
  highlighted = false,
}: {
  post: FeedPost;
  agent?: Agent | undefined;
  actions: FeedPostActions;
  onOpen: () => void;
  onLike: (liked: boolean) => void;
  /** Opened from a chat's "Posted to Feed" card. */
  highlighted?: boolean;
}) {
  const [imageBroken, setImageBroken] = useState(false);
  const summary = cardSummary(post);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <article
          id={`feed-post-${post.id}`}
          data-split-id={post.id}
          className={cn("flex flex-col gap-1 p-4", CARD_SURFACE, CARD_INTERACTIVE, highlighted && CARD_SELECTED)}
        >
          <div role="button" tabIndex={0} aria-label={post.title} onClick={onOpen} onKeyDown={(event) => event.key === "Enter" && onOpen()} className="flex cursor-pointer items-start gap-3 rounded-lg focus-ring">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-1.5">
                {agent ? <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={18} /> : null}
                <span className="truncate text-xs text-fg-subtle">
                  {[agent?.name, formatAgo(post.createdAt)].filter(Boolean).join(" · ")}
                </span>
              </div>
              <h3 className="line-clamp-2 text-[15px] font-semibold text-fg">{post.title}</h3>
              {summary ? <p className="line-clamp-2 text-sm text-fg-muted">{summary}</p> : null}
            </div>
            {post.imageUrl && !imageBroken ? (
              <img src={post.imageUrl} alt={post.imageCaption ?? ""} loading="lazy" referrerPolicy="no-referrer" onError={() => setImageBroken(true)} className="size-[76px] shrink-0 rounded-[10px] object-cover" />
            ) : null}
          </div>
          <footer className="-mb-1 flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              aria-pressed={post.liked}
              aria-label={post.liked ? t("feed.unlike") : t("feed.like")}
              onClick={() => onLike(!post.liked)}
              className={cn("size-8 rounded-full text-fg-muted", post.liked && "text-danger")}
            >
              <Heart className={cn("size-4", post.liked && "fill-current")} />
            </Button>
            {actions.onReply ? (
              <Button variant="ghost" size="icon" aria-label={t("feed.reply")} className="size-8 rounded-full text-fg-muted" onClick={actions.onReply}>
                <MessageSquare className="size-4" />
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t("feed.more")} className="ml-auto size-8 rounded-full text-fg-muted">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">{menuItems(actions, DropdownMenuItem)}</DropdownMenuContent>
            </DropdownMenu>
          </footer>
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent>{menuItems(actions, ContextMenuItem)}</ContextMenuContent>
    </ContextMenu>
  );
}
