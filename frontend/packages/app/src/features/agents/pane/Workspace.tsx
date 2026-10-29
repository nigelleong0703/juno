import type { Agent } from "@agent-desktop/client";
import { Button, SegmentedControl } from "@agent-desktop/ui";
import { ExternalLink, X } from "lucide-react";
import { useNavigate } from "react-router";
import { AgentScopeButton } from "../../../components/agent/AgentScopeButton";
import { ConversationFilesPanel } from "../../../components/chat-files";
import { TasksPanel } from "../../../components/computer";
import { dragRegion, noDragRegion } from "../../../lib/drag";
import { t } from "../../../lib/i18n";
import { useUiStore, type WorkspaceTab } from "../../../store/ui";
import { statusLine } from "../card/AgentProfile";
import { ComputerTab, WorkspaceTasks } from "../card/activityTabs";
import { AgentPanelPopover } from "./AgentPanel";

const VIEWS: { value: WorkspaceTab; label: string }[] = [
  { value: "computer", label: "agentCard.tab.computer" },
  { value: "files", label: "workspace.files" },
];

/**
 * The workspace in the right pane (the iPhone's Workspace): a small header (the agent's name, which opens the
 * management dropdown; in a group chat a picker of whose computer to show), then Computer | Files. Computer is
 * the live screen with the agent's current tasks under it. The screen stays mounted when Files is shown so its
 * stream survives the switch.
 */
export function Workspace({
  agent,
  members,
  conversationId,
  onPickAgent,
  onClose,
}: {
  agent: Agent;
  /** Group chats: the agents to pick from; omitted in a one-to-one chat. */
  members?: Agent[];
  conversationId: string;
  onPickAgent: (agentId: string) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const tab = useUiStore((state) => state.workspaceTab);
  const setTab = useUiStore((state) => state.setWorkspaceTab);
  const status = statusLine(agent.status);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div style={dragRegion} className="flex h-[var(--shell-header-height)] shrink-0 select-none items-center justify-between gap-2 px-3">
        <span className="flex min-w-0 items-center">
          {members ? (
            <span style={noDragRegion} className="flex min-w-0 items-center">
              <AgentScopeButton agents={members} value={agent.id} onChange={onPickAgent} all={false} label={t("workspace.pickAgent")} />
            </span>
          ) : (
            <AgentPanelPopover anchor="workspace" conversationId={conversationId} align="start">
              <button
                type="button"
                style={noDragRegion}
                aria-label={t("workspace.manage", { name: agent.name })}
                className="flex min-w-0 items-baseline gap-2 rounded-full px-2.5 py-1 transition-colors hover:bg-interactive-hover focus-ring"
              >
                <span className="truncate text-sm font-semibold text-fg">{agent.name}</span>
                <span className={`shrink-0 text-xs font-medium ${status.tone}`}>{t(status.label)}</span>
              </button>
            </AgentPanelPopover>
          )}
        </span>
        <Button style={noDragRegion} variant="ghost" size="icon-sm" className="rounded-full" aria-label={t("agentPane.close")} onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      {/* The switcher stays compact and centred; only the screen below takes the full pane width. */}
      <div className="flex shrink-0 justify-center px-3 pt-1">
        <SegmentedControl
          fill
          aria-label={t("workspace.sections")}
          value={tab}
          onValueChange={(value) => setTab(VIEWS.find((view) => view.value === value)?.value ?? "computer")}
          items={VIEWS.map((view) => ({ value: view.value, label: t(view.label) }))}
          className="h-9 w-72"
        />
      </div>

      {/* The screen takes the whole pane: full width, shrunk only so the screen and its control bar fit
          the pane height (data-fit-height + the size container, see controlShape.css). */}
      <div hidden={tab !== "computer"} data-fit-height className="min-h-0 flex-1 overflow-y-auto pt-1 [container-type:size]">
        <ComputerTab key={agent.id} agent={agent} conversationId={conversationId} />
        <TasksPanel key={`plan-${agent.id}`} agentId={agent.id} />
        <WorkspaceTasks key={`tasks-${agent.id}`} agent={agent} />
      </div>
      {tab === "files" ? (
        <div className="flex min-h-0 flex-1 flex-col pt-1">
          <div className="flex shrink-0 justify-end px-3">
            <Button variant="ghost" size="xs" onClick={() => navigate(`/library?conversationId=${encodeURIComponent(conversationId)}`)}>
              {t("workspace.openInLibrary")}
              <ExternalLink />
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <ConversationFilesPanel conversationId={conversationId} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
