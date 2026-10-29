import { useMatch } from "react-router";
import { useConversation, useConversations } from "../data/queries";

export interface RouteConversation {
  conversationId: string | undefined;
  agentId: string | undefined;
}

/**
 * Resolve only the current route: a cold detail query can use its list identity,
 * but an empty detail or failed query must not keep another agent's screen alive.
 */
export function useRouteConversation(): RouteConversation {
  const conversationMatch = useMatch("/c/:conversationId");
  const conversationId = conversationMatch?.params.conversationId;
  const { data: conversation, isError: conversationError } = useConversation(conversationId);
  const { data: conversations } = useConversations();
  const routeConversation =
    conversation ?? conversations?.find((entry) => entry.id === conversationId);
  const agentId = conversationError ? undefined : routeConversation?.agentIds[0];
  return { conversationId, agentId };
}
