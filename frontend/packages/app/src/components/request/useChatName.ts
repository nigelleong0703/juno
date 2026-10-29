import { useCallback } from "react";
import { useConversations } from "../../data/queries";
import { chatLabel, type ChatName } from "./decision";

/** Names a chat in a decision: the title the server sent, else the conversation's own title (by id), else "a chat". */
export function useChatName(): ChatName {
  const { data: conversations } = useConversations();
  return useCallback<ChatName>((conversationId, title) => chatLabel(title?.trim() || conversations?.find((entry) => entry.id === conversationId)?.title), [conversations]);
}
