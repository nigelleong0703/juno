import type { Agent, Conversation, Request } from "@agent-desktop/client";
import { useNavigate } from "react-router";
import { ModelProviderNotice } from "../../components/conversation/ModelProviderNotice";
import { ConversationView } from "../../components/conversation/ConversationView";
import { usePlatform } from "../../data/ClientProvider";
import { useDiscardSend, useSendMessage, useStopRun, useUploadFile } from "../../data/mutations";
import { useMarkOpenConversationRead } from "../../data/markOpenRead";
import { useAgent, useAgents, useConversation, useConversations, useItems, useNeedsYouRequests, useRuns } from "../../data/queries";
import { useUiStore } from "../../store/ui";
import { AgentPanelPopover } from "../agents/pane/AgentPanel";
import { useAutoOpenComputer } from "./useAutoOpenComputer";

export interface ConversationContainerProps {
  conversationId: string;
  onOpenRun?: (runId: string) => void;
  onOpenRoutine?: (routineId: string) => void;
  onOpenSignin?: (request: Request) => void;
  className?: string;
}

/**
 * The conversation's feature container: it owns every piece of orchestration the view must not —
 * TanStack Query reads, the send / pin mutations, the router and the UI store — and hands the
 * presentational `ConversationView` typed data and actions. This keeps `ConversationView` a pure
 * function of its props (ARCHITECTURE §5.5) while preserving its public call shape for routes.
 */
/**
 * The agent's canonical direct chat: a `direct` conversation whose *only* agent is `agentId`.
 * A multi-agent direct, room or peer chat must never stand in for it (mention Message and
 * `/agents/:agentId` both rely on this exact target).
 */
export function findDirectConversationId(
  conversations: Conversation[] | undefined,
  agentId: string,
): string | undefined {
  return (conversations ?? []).find(
    (conversation) =>
      conversation.kind === "direct" &&
      conversation.agentIds.length === 1 &&
      conversation.agentIds[0] === agentId,
  )?.id;
}

export function ConversationContainer({
  conversationId,
  onOpenRun,
  onOpenRoutine,
  onOpenSignin,
  className,
}: ConversationContainerProps) {
  const navigate = useNavigate();
  const platform = usePlatform();
  const { data: conversation, isLoading, isError, refetch } = useConversation(conversationId);
  const { data: items, isLoading: itemsLoading } = useItems(conversationId);
  useMarkOpenConversationRead(conversation?.id, items);
  const { data: agents } = useAgents();
  const { data: conversations } = useConversations();
  const { data: primaryAgent } = useAgent(conversation?.agentIds[0]);
  // H-94: every run of this chat (any status); the view picks the live one it can stop.
  const { data: runs } = useRuns({ conversationId });
  useAutoOpenComputer(conversationId, runs);
  const stopRun = useStopRun();
  const uploadFile = useUploadFile();
  const send = useSendMessage(conversationId);
  const discardSend = useDiscardSend(conversationId);
  // A failed send keeps the original admission identity, including a lost response.
  const retrySend = send.retry;

  const computerPanelOpen = useUiStore((state) => state.computerPanelOpen);
  const toggleComputerPanel = useUiStore((state) => state.toggleComputerPanel);
  const setComputerPanelOpen = useUiStore((state) => state.setComputerPanelOpen);
  const addComposeRecipient = useUiStore((state) => state.addComposeRecipient);

  const clearCompose = useUiStore((state) => state.clearCompose);

  const handleOpenAgent = (agentId: string) => {
    const directId = findDirectConversationId(conversations, agentId);
    if (directId) {
      navigate(`/c/${directId}`);
      return;
    }
    const agent: Agent | undefined = (agents ?? []).find((entry) => entry.id === agentId);
    if (!agent) return;
    clearCompose();
    addComposeRecipient({ key: agent.id, kind: "agent", agentId: agent.id, name: agent.name });
    navigate("/new");
  };

  const { data: needsYou } = useNeedsYouRequests();
  return (
    <ConversationView
      conversation={conversation}
      waitingOnYou={needsYou?.some((request) => request.conversationId === conversation?.id)}
      onUploadFile={uploadFile}
      items={items}
      itemsLoading={itemsLoading}
      agents={agents}
      primaryAgent={primaryAgent}
      runningRuns={runs}
      isLoading={isLoading}
      isError={isError}
      sending={send.isPending}
      computerPanelOpen={computerPanelOpen}
      onRetry={() => void refetch()}
      onSend={(payload) => send.mutate(payload)}
      onRetrySend={retrySend}
      onDeleteSend={discardSend}
      onToggleComputerPanel={toggleComputerPanel}
      // Owner feedback 2026-10-05: a system item's "View computer" must OPEN the pane, never
      // toggle it shut. The shell already aims the pane at the conversation's primary agent
      // (AppShell derives `agentId` from the route), so opening is the whole job here.
      onSystemAction={(command) => {
        if (command === "computer.open") setComputerPanelOpen(true);
      }}
      onOpenRun={onOpenRun}
      onStopRun={(runId) => stopRun.mutate(runId)}
      onOpenRoutine={onOpenRoutine}
      onOpenSignin={onOpenSignin}
      agentPanel={(trigger) => (
        <AgentPanelPopover anchor="header" conversationId={conversationId}>
          {trigger}
        </AgentPanelPopover>
      )}
      footerNotice={<ModelProviderNotice runs={runs?.filter((run) => run.conversationId === conversationId)} />}
      onOpenAgent={conversations ? handleOpenAgent : undefined}
      onOpenCitation={(url) => platform.openExternal(url)}
      className={className}
    />
  );
}
