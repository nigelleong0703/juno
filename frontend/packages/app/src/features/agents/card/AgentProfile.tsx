import type { Agent } from "@agent-desktop/client";
import { Button, Section, SegmentedControl, cn, toast } from "@agent-desktop/ui";
import { ArrowLeft, Blocks, CalendarClock, CircleAlert, Fingerprint, ListTodo, Moon, Pencil, Share, ShieldCheck } from "lucide-react";
import { useState, type ComponentType } from "react";
import { useAuthIdentity } from "../../../auth/AuthContext";
import { AgentAvatar } from "../../../components/agent/AgentAvatar";
import { t } from "../../../lib/i18n";
import { UsageLedger } from "../../usage/UsageLedger";
import { AgentEditDialog } from "../AgentProfileForm";
import { canEditAgent } from "../canEditAgent";
import { ActivityTab } from "./activityTabs";
import { AgentMenu, StopAgentButton } from "./RunControls";
import { AutomationsTab } from "./AutomationsTab";
import { useAgentActivity } from "./parts";
import { AppsTab } from "./AppsTab";
import { MemoryTab } from "./MemoryTab";
import { PermissionsTab } from "./PermissionsTab";

/** The management tabs, in the iPhone's order and icons (Agents.swift ProfileTab) minus Computer: on desktop the workspace is the computer. */
type AgentPanelTab = "activity" | "permissions" | "apps" | "schedules" | "memory";

const TABS: { id: AgentPanelTab; icon: ComponentType<{ className?: string }>; label: string }[] = [
  { id: "activity", icon: ListTodo, label: "agentCard.tab.activity" },
  { id: "permissions", icon: ShieldCheck, label: "agentCard.tab.permissions" },
  { id: "apps", icon: Blocks, label: "agentCard.tab.apps" },
  { id: "schedules", icon: CalendarClock, label: "agentCard.tab.schedules" },
  { id: "memory", icon: Fingerprint, label: "agentCard.tab.memory" },
];

/**
 * The status line under the name: the iPhone's word per status, with an icon for the states that need one. Working and
 * free have none: they show the live dot (green while working, grey when free) that Team › Agents uses.
 */
export function statusLine(status: Agent["status"]): { icon?: ComponentType<{ className?: string }>; tone: string; label: string } {
  switch (status) {
    case "sleeping":
      return { icon: Moon, tone: "text-fg-muted", label: "status.agent.sleeping" };
    case "error":
      return { icon: CircleAlert, tone: "text-danger", label: "status.agent.error" };
    case "needs_you":
      return { icon: CircleAlert, tone: "text-warning", label: "status.agent.needsYou" };
    case "working":
      return { tone: "text-success", label: "status.agent.working" };
    default:
      return { tone: "text-fg-muted", label: "status.agent.idle" };
  }
}

/** Share the agent as a line of text, like iOS's ShareLink: the system share sheet, else the clipboard. */
function shareAgent(agent: Agent): void {
  const text = t("agentCard.shareText", { name: agent.name });
  if (navigator.share) void navigator.share({ text }).catch(() => undefined);
  else void navigator.clipboard.writeText(text).then(() => toast(t("agentCard.shareCopied")));
}

export interface AgentProfileProps {
  agent: Agent;
  className?: string;
  /** Group chats: back to the members list. */
  onBack?: () => void;
}

/**
 * The one agent panel, after the iPhone's agent page (Agents.swift AgentProfileView): a big avatar with
 * an edit pencil, the name, a status line, then five icon tabs — Activity, Permissions, Channels, Automations,
 * Memory (the live Computer is the workspace pane). The pencil opens the Edit agent dialog (avatar, name,
 * role); the identity files are in Memory. It shows in the dropdown off the chat header and on the full agent page.
 */
export function AgentProfile({ agent, className, onBack }: AgentProfileProps) {
  const [tab, setTab] = useState<AgentPanelTab>("activity");
  const [editing, setEditing] = useState(false);
  const identity = useAuthIdentity();
  const { doing, working } = useAgentActivity(agent);
  const status = statusLine(agent.status);
  const StatusIcon = status.icon;
  // Idle shows no buttons: "Free". Working shows the doing line with a Stop. Paused reads "Paused" in place of either.
  const paused = agent.pausedAt !== undefined;
  const statusText = paused ? t("status.agent.paused") : (doing ?? t(status.label));

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div className="flex h-12 shrink-0 items-center justify-between px-3">
        {onBack ? (
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={t("agentPanel.members")} onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={t("agentCard.share")} onClick={() => shareAgent(agent)}>
            <Share className="size-4" />
          </Button>
          <AgentMenu agent={agent} />
        </span>
      </div>
      <header className="flex shrink-0 flex-col items-center px-6 text-center">
        <div className="relative">
          <AgentAvatar agentId={agent.id} avatar={agent.avatar} status={agent.status} size={96} />
          <button
            type="button"
            aria-label={t("agentCard.edit")}
            onClick={() => setEditing(true)}
            className="absolute -bottom-0.5 -right-1 flex size-7 items-center justify-center rounded-full border border-border bg-muted text-fg focus-ring"
          >
            <Pencil className="size-3.5" />
          </button>
        </div>
        <h2 className="mt-3 max-w-full truncate text-[22px] font-bold leading-tight text-fg">{agent.name}</h2>
        <p className="mt-0.5 max-w-full truncate text-sm text-fg-muted">{agent.title}</p>
        <div className="mt-1.5 flex max-w-full items-center gap-2 text-sm font-medium text-fg">
          <p className="flex min-w-0 items-center gap-1.5">
            {StatusIcon && !paused ? (
              <StatusIcon className={cn("size-[18px] shrink-0", status.tone)} />
            ) : (
              <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", working && !paused ? "bg-success" : "bg-fg-subtle/50")} />
            )}
            <span className="truncate">{statusText}</span>
          </p>
          {working ? <StopAgentButton agent={agent} /> : null}
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl shrink-0 px-4 pt-4">
        <SegmentedControl
          fill
          iconOnly
          aria-label={t("agentPanel.sections")}
          value={tab}
          onValueChange={(value) => setTab(TABS.find((entry) => entry.id === value)?.id ?? "activity")}
          items={TABS.map(({ id, icon: Icon, label }) => ({ value: id, label: t(label), icon: <Icon className="size-4" /> }))}
          className="h-10"
        />
      </div>

      <AgentEditDialog agent={agent} open={editing} onOpenChange={setEditing} readOnly={!canEditAgent(agent, identity?.mode === "account" ? identity.user.id : undefined)} />

      <div className="min-h-0 flex-1 overflow-y-auto pb-6 pt-4">
        <div className="mx-auto w-full max-w-2xl px-2">
          {tab === "activity" ? <ActivityTab agent={agent} /> : null}
          {tab === "permissions" ? <PermissionsTab agent={agent} /> : null}
          {tab === "apps" ? <AppsTab agent={agent} /> : null}
          {tab === "schedules" ? <AutomationsTab agent={agent} /> : null}
          {tab === "memory" ? <MemoryTab agent={agent} /> : null}
          <Section title={t("agentCard.usage")} className="mt-8">
            <UsageLedger agentId={agent.id} />
          </Section>
        </div>
      </div>
    </div>
  );
}
