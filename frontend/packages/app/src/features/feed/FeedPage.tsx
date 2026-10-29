import type { FeedPost } from "@agent-desktop/client";
import { Button, EmptyState, ErrorState, LoadingState, ScrollArea, SplitView } from "@agent-desktop/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { markFeedSeen, useLikeFeedPost } from "../../data/feed";
import { usePlatform } from "../../data/ClientProvider";
import { useAgents, useFeed, useRoutines } from "../../data/queries";
import { t } from "../../lib/i18n";
import { useSplitSelection, useWideLayout } from "../../lib/useSplitSelection";
import { AgentScopeButton } from "../../components/agent/AgentScopeButton";
import { PageFrame } from "../../components/page/PageFrame";
import { FeedForwardDialog, FeedReasonDialog } from "./FeedDialogs";
import { FeedPostCard, type FeedPostActions } from "./FeedPostCard";
import { FeedPostBody, FeedPostDialog } from "./FeedPostDialog";
import { useFeedActions } from "./useFeedActions";

/**
 * Feed (BACKEND §10.10, Muse's Feed): news and progress the agents post without needing the user,
 * newest first, as iPhone's compact cards. A card opens the post; Reply, Forward… and Not interested live in its menu.
 */
export function FeedPage() {
  const navigate = useNavigate();
  const wide = useWideLayout();
  const openId = useParams().postId;
  const postParam = useSearchParams()[0].get("post") ?? undefined;
  const target = postParam ?? openId;
  const [agentId, setAgentId] = useState("all");
  const feed = useFeed(agentId === "all" ? undefined : { agentId });
  const { data: agents } = useAgents();
  const like = useLikeFeedPost();
  const { data: routines } = useRoutines();
  const platform = usePlatform();
  const actions = useFeedActions();
  const [forwarding, setForwarding] = useState<FeedPost>();
  const [declining, setDeclining] = useState<FeedPost>();
  // "Not interested" posts stay hidden: the server keeps the signal and the post carries it back.
  const posts = useMemo(
    () => (feed.data?.pages.flatMap((page) => page.items) ?? []).filter((post) => post.feedback !== "less" && !actions.hidden.has(post.id)),
    [feed.data, actions.hidden],
  );
  const opened = posts.find((post) => post.id === openId);
  const open = useCallback((id: string | undefined) => navigate(id ? `/feed/${id}` : "/feed"), [navigate]);
  const ids = useMemo(() => posts.map((post) => post.id), [posts]);
  useSplitSelection(ids, openId, open, wide);
  const postActions = (post: FeedPost): FeedPostActions => ({
    onReply: actions.canReply(post) ? () => actions.reply(post) : undefined,
    onForward: () => setForwarding(post),
    onOpenSource: post.sourceUrl ? () => platform.openExternal(post.sourceUrl ?? "") : undefined,
    onDecline: () => setDeclining(post),
  });

  // Opened from a chat's "Posted to Feed" card: bring that post into view (later pages load until it shows).
  const found = posts.some((post) => post.id === target);
  useEffect(() => {
    if (target && found) document.getElementById(`feed-post-${target}`)?.scrollIntoView({ block: postParam ? "center" : "nearest" });
    else if (target && feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [target, postParam, found, feed]);

  // Opening the Feed clears its nav badge; leaving it counts posts that arrived meanwhile as seen too.
  useEffect(() => {
    markFeedSeen();
    return markFeedSeen;
  }, []);

  const openedProps = (post: FeedPost) => ({
    post,
    agent: agents?.find((entry) => entry.id === post.agentId),
    routineTitle: routines?.find((routine) => routine.id === post.routineId)?.name,
    actions: postActions(post),
    onUseful: () => actions.useful(post),
  });
  const list = feed.isLoading ? (
    <LoadingState label={t("common.loading")} />
  ) : feed.isError ? (
    <ErrorState title={t("common.error")} onRetry={() => void feed.refetch()} />
  ) : posts.length === 0 ? (
    <EmptyState title={t("feed.empty")} description={t("feed.emptyHint")} />
  ) : (
    <>
      {posts.map((post) => (
        <FeedPostCard
          key={post.id}
          post={post}
          highlighted={post.id === target}
          agent={agents?.find((entry) => entry.id === post.agentId)}
          actions={postActions(post)}
          onOpen={() => open(post.id)}
          onLike={(liked) => like.mutate({ id: post.id, liked })}
        />
      ))}
      {feed.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
            {t("common.showMore")}
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <PageFrame
      fullWidth
      title={t("feed.title")}
      scope={<AgentScopeButton bubble agents={agents} value={agentId} onChange={setAgentId} />}
    >
      {wide ? (
        <SplitView
          list={<div className="flex flex-col gap-3 px-4 pb-4 pt-1">{list}</div>}
          detail={
            opened ? (
              <div className="mx-auto w-full max-w-[720px] px-8 pb-10 pt-8">
                <FeedPostBody key={opened.id} {...openedProps(opened)} />
              </div>
            ) : undefined
          }
          placeholder={t("feed.pickPost")}
          listWidth={400}
          className="[&_[data-slot=split-view-list]]:border-r-0"
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 pb-10">{list}</div>
        </ScrollArea>
      )}

      {opened && !wide ? <FeedPostDialog {...openedProps(opened)} onClose={() => open(undefined)} /> : null}
      {forwarding ? <FeedForwardDialog onPick={(conversationId) => actions.forward(forwarding, conversationId)} onClose={() => setForwarding(undefined)} /> : null}
      {declining ? <FeedReasonDialog post={declining} onSubmit={(input) => actions.decline(declining, input)} onClose={() => setDeclining(undefined)} /> : null}
    </PageFrame>
  );
}
