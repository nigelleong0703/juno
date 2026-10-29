import type { Conversation, FeedPost, FeedbackInput } from "@agent-desktop/client";
import { toast } from "@agent-desktop/ui";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useClient } from "../../data/ClientProvider";
import { useFeedPostFeedback } from "../../data/feed";
import { useAgents, useConversations } from "../../data/queries";
import { t } from "../../lib/i18n";
import { useUiStore } from "../../store/ui";
import { cardSummary } from "./cardSummary";

/** How long "Not interested" can be undone before the server is told. */
const UNDO_MS = 5000;

/** The chat with this agent, if the user has one: "Reply" needs somewhere to put the draft. */
export const directChatOf = (conversations: Conversation[] | undefined, agentId: string) =>
  conversations?.find((conversation) => conversation.kind === "direct" && conversation.agentIds.includes(agentId));

/** The text a "Reply" puts in the agent's composer: the post quoted, then the user's own words. Nothing is sent. */
export function discussDraft(post: FeedPost, agentName: string): string {
  const quoted = [post.title, post.summary]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 1200)
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `${t("feed.discussLead", { agent: agentName })}\n\n${quoted}\n\n`;
}

/** What "Forward…" sends, as on iPhone: the title in bold, the summary and the source link. */
export const forwardText = (post: FeedPost) =>
  [post.title ? `**${post.title}**` : "", cardSummary(post), post.sourceUrl ?? ""].filter(Boolean).join("\n\n");

/**
 * What the Feed does with a post besides reading it: Reply (the agent's chat with the post quoted), Forward, and
 * "Not interested" (hidden at once, told to the server after a 5 s Undo window, as on iPhone). Reply and Forward
 * also say "more" once, silently.
 */
export function useFeedActions() {
  const navigate = useNavigate();
  const client = useClient();
  const { data: agents } = useAgents();
  const { data: conversations } = useConversations();
  const feedback = useFeedPostFeedback();
  const setComposerPrefill = useUiStore((state) => state.setComposerPrefill);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const send = useMutation({ mutationFn: ({ conversationId, text }: { conversationId: string; text: string }) => client.conversations.send(conversationId, { text }) });

  const noteInterest = (post: FeedPost) => {
    if (post.feedback !== "more") feedback.mutate({ id: post.id, input: { signal: "more" } });
  };
  const setHiddenId = (id: string, on: boolean) =>
    setHidden((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const reply = (post: FeedPost) => {
    const agent = agents?.find((entry) => entry.id === post.agentId);
    const chat = directChatOf(conversations, post.agentId);
    if (!chat || !agent) return;
    noteInterest(post);
    setComposerPrefill({ conversationId: chat.id, text: discussDraft(post, agent.name) });
    navigate(`/c/${chat.id}`);
  };

  const forward = (post: FeedPost, conversationId: string) => {
    noteInterest(post);
    send.mutate(
      { conversationId, text: forwardText(post) },
      { onSuccess: () => toast(t("feed.forwarded")), onError: () => toast.error(t("common.error")) },
    );
  };

  const flush = useCallback(
    (id: string, input: FeedbackInput) => {
      timers.current.delete(id);
      feedback.mutate({ id, input });
    },
    [feedback],
  );

  const decline = (post: FeedPost, input: FeedbackInput) => {
    setHiddenId(post.id, true);
    const timer = setTimeout(() => flush(post.id, input), UNDO_MS);
    timers.current.set(post.id, timer);
    const agentName = agents?.find((entry) => entry.id === post.agentId)?.name ?? t("feed.yourAgent");
    toast(t("feed.declined", { agent: agentName }), {
      duration: UNDO_MS,
      action: {
        label: t("feed.undo"),
        onClick: () => {
          clearTimeout(timers.current.get(post.id));
          timers.current.delete(post.id);
          setHiddenId(post.id, false);
        },
      },
    });
  };

  const useful = (post: FeedPost) => feedback.mutate({ id: post.id, input: { signal: "more" } });

  return { hidden, useful, reply, forward, decline, canReply: (post: FeedPost) => Boolean(directChatOf(conversations, post.agentId)) };
}
