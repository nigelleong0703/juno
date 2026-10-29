import { Button, LoadingState } from "@agent-desktop/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, Navigate } from "react-router";
import type { Conversation } from "@agent-desktop/client";
import { useClient } from "../../data/ClientProvider";
import { useAgents } from "../../data/queries";
import { t } from "../../lib/i18n";
import { ENTRY_CONVERSATIONS_KEY, listEntryConversations } from "./listEntryConversations";
import { TodayPage } from "../today/TodayPage";

/** Set once this page load has decided where it opens; going Home later never jumps back into a chat. */
let launchChecked = false;

/** An account still in its first conversation: one direct chat, at most this many messages from the user. */
const FIRST_CHAT_USER_MESSAGES = 3;

/**
 * Two routes share this entry (owner-approved 2026-10-26, five tabs). `/` is Today; `/chat` is the Chat tab, where the
 * chat list sits beside the page and nothing is open yet. Both run the same launch decision below.
 *
 * The entry read pages through every conversations cursor page before it
 * decides whether the account has any chats, so a thread past the default
 * first page — or a first page holding only task/peer threads — cannot be
 * missed (the backend does not sort this listing). Both reads are
 * authoritative: while either is loading the entry stays on the loader, and
 * any load failure (including a later-page failure) offers a retry only —
 * never an empty state or a creation affordance. With no chats and no agents
 * the index hands off to /new, where the compose route owns first-agent versus
 * normal entry; otherwise it renders the Today page. On launch, an account that is still in its one
 * first conversation (the default agent's chat, at most 3 messages from the user) opens that chat. No stored tour flags and
 * no automatic creation happen here.
 */
export function ChatIndexPage({ view }: { view: "today" | "chat" }) {
  const client = useClient();
  const conversationsQuery = useQuery({
    queryKey: ENTRY_CONVERSATIONS_KEY,
    queryFn: () => listEntryConversations(client),
  });
  const agentsQuery = useAgents();

  const conversations = conversationsQuery.data;
  const solo = launchChecked ? undefined : soleDirectChat(conversations);
  const firstChat = useQuery({
    queryKey: ["first-chat-gate", solo?.id],
    enabled: solo !== undefined,
    queryFn: async () => {
      const page = await client.conversations.items(solo?.id as string);
      return page.nextCursor === null && page.items.filter((item) => item.type === "user_message").length <= FIRST_CHAT_USER_MESSAGES;
    },
  });
  const deciding = !launchChecked && (conversationsQuery.isLoading || (solo !== undefined && firstChat.isLoading));
  useEffect(() => {
    if (!deciding && conversations !== undefined) launchChecked = true;
  }, [deciding, conversations]);

  if (conversationsQuery.isLoading || agentsQuery.isLoading || (solo !== undefined && firstChat.isLoading)) {
    return <LoadingState label={t("common.loading")} />;
  }

  if (conversationsQuery.isError || agentsQuery.isError) {
    const retry = () => {
      void conversationsQuery.refetch();
      void agentsQuery.refetch();
    };
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="flex w-full max-w-xs flex-col items-center text-center">
          <p role="alert" className="text-sm text-fg-muted">
            {t("common.error")}
          </p>
          <Button variant="primary" size="sm" onClick={retry} className="mt-3">
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (solo !== undefined && firstChat.data === true) return <Navigate to={`/c/${solo.id}`} replace />;

  // Task and peer threads never count as the account's own chats.
  const ownChats = (conversations ?? []).filter(
    (conversation) => conversation.kind === "direct" || conversation.kind === "room",
  );
  const agents = agentsQuery.data ?? [];
  if (ownChats.length === 0 && agents.length === 0) return <Navigate to="/new" replace />;

  if (view === "today") return <TodayPage />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-[15px] text-fg-muted">{t("chat.pickChat")}</p>
      <Button asChild variant="primary" size="sm" className="rounded-full">
        <Link to="/new">{t("sidebar.newChat")}</Link>
      </Button>
    </div>
  );
}

/** The account's only conversation, when it is the default agent's direct chat. */
function soleDirectChat(conversations: readonly Conversation[] | undefined): Conversation | undefined {
  return conversations?.length === 1 && conversations[0]?.kind === "direct" ? conversations[0] : undefined;
}
