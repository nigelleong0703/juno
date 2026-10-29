import type { Agent } from "@agent-desktop/client";
import { cn, EmptyState } from "@agent-desktop/ui";
import { AgentAvatar } from "../../agent/AgentAvatar";
import { usePeople } from "../../../auth/AuthContext";
import { tc } from "../i18n";

export interface MembersPanelProps {
  /** Agents in this group conversation. */
  agents: Agent[];
  /** Human member ids in this group conversation. */
  memberIds: string[];
  className?: string;
}

/**
 * "Members" tab (§6) — shown for group chats only. Lists the agents and the people in the
 * conversation. Member display names come from `lib/people` (the client exposes no member
 * endpoint yet).
 */
export function MembersPanel({ agents, memberIds, className }: MembersPanelProps) {
  const { isSelf, memberName } = usePeople();
  const isEmpty = agents.length === 0 && memberIds.length === 0;

  if (isEmpty) {
    return (
      <EmptyState centered
        title={tc("computer.members.empty")}
        className={className}
      />
    );
  }

  return (
    <div className={cn("space-y-4 p-3", className)}>
      {agents.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
            {tc("computer.members.agents")}
          </h3>
          <ul className="space-y-1">
            {agents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-2.5 py-1">
                <AgentAvatar agentId={agent.id} avatar={agent.avatar} status={agent.status} size="sm" flat />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{agent.name}</span>
                <span className="shrink-0 text-xs text-fg-subtle">@{agent.handle}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {memberIds.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
            {tc("computer.members.people")}
          </h3>
          <ul className="space-y-1">
            {memberIds.map((id) => (
              <li key={id} className="flex items-center gap-2.5 py-1">
                <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-fg-muted">
                  {memberName(id).slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg">
                  {isSelf(id) ? tc("computer.members.you") : memberName(id)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
