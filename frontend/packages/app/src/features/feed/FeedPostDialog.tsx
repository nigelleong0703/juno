import type { Agent, FeedPost } from "@agent-desktop/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  MessageResponse,
} from "@agent-desktop/ui";
import { Check, ExternalLink, Forward } from "lucide-react";
import { useState } from "react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { UiDoc } from "../../components/uidoc/UiDoc";
import { formatAgo } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { FeedPostActions } from "./FeedPostCard";

export interface FeedPostBodyProps {
  post: FeedPost;
  agent?: Agent | undefined;
  /** The routine that posted it, when it still exists. */
  routineTitle?: string | undefined;
  actions: FeedPostActions;
  onUseful: () => void;
}

/**
 * A post opened in full (iPhone's post page): agent and time, title, picture, summary, write-up and display blocks,
 * then "Was this useful?" and a "Reply to <agent>…" bar that opens that agent's chat with the post quoted.
 * The dialog on a narrow screen and the reading pane on a wide one share it.
 */
export function FeedPostBody({
  post,
  agent,
  routineTitle,
  actions,
  onUseful,
}: FeedPostBodyProps) {
  const [imageBroken, setImageBroken] = useState(false);
  const agentName = agent?.name ?? t("feed.yourAgent");

  return (
    <div className="flex flex-col gap-4">
      <div data-slot="feed-head" className="flex items-center gap-2.5">
        {agent ? (
          <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={32} />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">
            {agent?.name ?? ""}
          </p>
          <p className="truncate text-xs text-fg-subtle">
            {[
              routineTitle ? t("feed.fromSource", { title: routineTitle }) : "",
              formatAgo(post.createdAt),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("feed.forward")}
          className="size-8 rounded-full text-fg-muted"
          onClick={actions.onForward}
        >
          <Forward className="size-4" />
        </Button>
      </div>
      <h2 className="text-[22px] font-semibold leading-snug tracking-[-0.01em] text-fg">{post.title}</h2>
      {post.imageUrl && !imageBroken ? (
        <figure className="flex flex-col gap-1.5">
          <img
            src={post.imageUrl}
            alt={post.imageCaption ?? ""}
            referrerPolicy="no-referrer"
            onError={() => setImageBroken(true)}
            className="aspect-video w-full rounded-2xl object-cover"
          />
          {post.imageCaption ? <figcaption className="px-1 text-xs text-fg-subtle">{post.imageCaption}</figcaption> : null}
        </figure>
      ) : null}
      {post.summary ? (
        <p className="text-base text-fg">{post.summary}</p>
      ) : null}
      {post.body ? <MessageResponse>{post.body}</MessageResponse> : null}
      {post.ui ? <UiDoc doc={post.ui} showTitle /> : null}
      {actions.onOpenSource ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start rounded-full"
          onClick={actions.onOpenSource}
        >
          <ExternalLink className="size-4" />
          {t("feed.source")}
        </Button>
      ) : null}
      <div className="flex items-center gap-2 rounded-2xl bg-muted/70 p-3">
        {post.feedback === "more" ? (
          <p className="flex items-center gap-1.5 text-sm text-fg-muted">
            <Check className="size-4" />
            {t("feed.thanks", { agent: agentName })}
          </p>
        ) : (
          <>
            <p className="flex-1 text-sm text-fg-muted">
              {t("feed.wasUseful")}
            </p>
            <Button
              variant="secondary"
              size="xs"
              className="rounded-full"
              onClick={onUseful}
            >
              {t("feed.useful")}
            </Button>
            <Button
              variant="secondary"
              size="xs"
              className="rounded-full"
              onClick={actions.onDecline}
            >
              {t("feed.notForMe")}
            </Button>
          </>
        )}
      </div>
      {actions.onReply ? (
        <button
          type="button"
          onClick={actions.onReply}
          className="flex h-10 w-full items-center rounded-full bg-muted px-4 text-left text-sm text-fg-muted focus-ring"
        >
          {t("feed.replyTo", { name: agentName })}
        </button>
      ) : null}
    </div>
  );
}

/** The post on a narrow screen: the shared body in a dialog. */
export function FeedPostDialog({
  onClose,
  ...body
}: FeedPostBodyProps & { onClose: () => void }) {
  const { actions } = body;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-xl gap-4 overflow-y-auto [&_[data-slot=feed-head]]:pr-8">
        <DialogTitle className="sr-only">{body.post.title}</DialogTitle>
        <DialogDescription className="sr-only">
          {body.post.summary}
        </DialogDescription>
        <FeedPostBody
          {...body}
          actions={{
            ...actions,
            onReply: actions.onReply
              ? () => {
                  onClose();
                  actions.onReply?.();
                }
              : undefined,
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
