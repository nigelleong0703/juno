import { ErrorState, LoadingState } from "@agent-desktop/ui";
import { useParams } from "react-router";
import { useConversation } from "../../data/queries";
import { t } from "../../lib/i18n";
import { ConversationPage } from "../../templates/ConversationPage";

/** One conversation at `/c/:conversationId` — direct chat, group chat or task thread (§4.3). */
export function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { isLoading, isError, refetch } = useConversation(conversationId);

  if (isLoading) return <LoadingState label={t("common.loading")} />;
  if (isError || !conversationId) {
    return <ErrorState title={t("common.error")} onRetry={() => void refetch()} />;
  }

  return <ConversationPage conversationId={conversationId} />;
}
