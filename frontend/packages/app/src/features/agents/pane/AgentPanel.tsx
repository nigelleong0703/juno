import { Popover, PopoverContent, PopoverTrigger } from "@agent-desktop/ui";
import { useState, type ReactElement } from "react";
import { useAgents, useConversation } from "../../../data/queries";
import { noDragRegion } from "../../../lib/drag";
import { useUiStore, type AgentPanelAnchor } from "../../../store/ui";
import { AgentProfile } from "../card/AgentProfile";
import { GroupMembers } from "./GroupMembers";

/**
 * The agent management dropdown (after the iPhone's agent page): the profile with Activity / Permissions /
 * Automations / Memory, or in a group chat the members first and then one agent's profile with a way back.
 * The conversation header's avatar and the workspace header's name each anchor one; the store keeps which is
 * open, so opening one closes the other. Closes on outside click and Esc.
 */
export function AgentPanelPopover({
  anchor,
  conversationId,
  align = "center",
  children,
}: {
  anchor: AgentPanelAnchor;
  conversationId: string;
  align?: "start" | "center" | "end";
  /** The button that toggles the dropdown. */
  children: ReactElement;
}) {
  const open = useUiStore((state) => state.agentPanelAnchor === anchor);
  const setOpen = (next: boolean) =>
    useUiStore.setState((state) => ({ agentPanelAnchor: next ? anchor : state.agentPanelAnchor === anchor ? null : state.agentPanelAnchor }));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      {/* A floating panel over the window's drag rows: it must take its own clicks (desktop drag regions). */}
      <PopoverContent
        align={align}
        style={noDragRegion}
        className="w-[420px] max-w-[calc(100vw-1rem)] overflow-hidden bg-bg! p-0 [backdrop-filter:none]! [-webkit-backdrop-filter:none]!"
      >
        <div className="flex max-h-[80vh] min-h-0 flex-col">
          <AgentPanelBody conversationId={conversationId} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AgentPanelBody({ conversationId }: { conversationId: string }) {
  const { data: conversation } = useConversation(conversationId);
  const { data: agents } = useAgents();
  const [picked, setPicked] = useState<string | null>(null);
  const isGroup = conversation?.kind === "room" || conversation?.kind === "peer";
  const members = (agents ?? []).filter((agent) => conversation?.agentIds.includes(agent.id));
  const agent = members.find((entry) => entry.id === (isGroup ? picked : conversation?.agentIds[0]));

  if (isGroup && conversation && !agent) return <GroupMembers conversation={conversation} members={members} onOpen={setPicked} />;
  if (!agent) return null;
  return <AgentProfile key={agent.id} agent={agent} {...(isGroup ? { onBack: () => setPicked(null) } : {})} />;
}
