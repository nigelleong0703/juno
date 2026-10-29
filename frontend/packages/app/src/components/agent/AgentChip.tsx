import type { Agent } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { AgentAvatar } from "./AgentAvatar";

export interface AgentChipProps {
  agent: Agent;
  /** `md` adds the @handle next to the name. */
  size?: "sm" | "md";
  /** Show the live status dot (dropdowns / mentions usually omit it). */
  showStatus?: boolean;
  className?: string;
  onClick?: () => void;
}

/** Small avatar + name, used for @mentions, filters and "used by" lists. */
export function AgentChip({ agent, size = "md", showStatus, className, onClick }: AgentChipProps) {
  const content = (
    <>
      <AgentAvatar
        agentId={agent.id}
        avatar={agent.avatar}
        status={showStatus ? agent.status : undefined}
        size={size === "sm" ? "xs" : "sm"}
        flat
      />
      <span className="truncate font-medium text-fg">{agent.name}</span>
      <span className="truncate text-fg-subtle">@{agent.handle}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex max-w-48 items-center gap-1.5 rounded-full bg-bg-subtle px-2 py-0.5 text-sm transition-colors hover:bg-sidebar-accent focus-ring",
          className,
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={cn("inline-flex max-w-48 items-center gap-1.5 text-sm", className)}>
      {content}
    </span>
  );
}
