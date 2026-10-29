import { useAgents, useConversation } from "../../../data/queries";
import { useUiStore } from "../../../store/ui";
import { Workspace } from "./Workspace";

/**
 * The right pane: only the conversation's workspace (Computer with the agent's tasks | Files) of the chat's
 * agent, or in a group chat of the agent picked in its header. Agent management is the dropdown off the
 * chat header (AgentPanelPopover).
 */
export function AgentPane({ agentId, conversationId }: { agentId: string; conversationId: string }) {
  const { data: conversation } = useConversation(conversationId);
  const { data: agents } = useAgents();
  const workspaceAgentId = useUiStore((state) => state.workspaceAgentId);

  const isGroup = conversation?.kind === "room" || conversation?.kind === "peer";
  const members = (agents ?? []).filter((agent) => conversation?.agentIds.includes(agent.id));
  const workspaceAgent = members.find((entry) => entry.id === workspaceAgentId) ?? agents?.find((entry) => entry.id === agentId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      {workspaceAgent ? (
        <Workspace
          agent={workspaceAgent}
          {...(isGroup ? { members } : {})}
          conversationId={conversationId}
          onPickAgent={(id) => useUiStore.getState().setWorkspaceAgent(id)}
          onClose={() => useUiStore.getState().setComputerPanelOpen(false)}
        />
      ) : null}
    </div>
  );
}
