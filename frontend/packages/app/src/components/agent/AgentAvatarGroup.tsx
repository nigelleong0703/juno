import type { Agent } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { AgentAvatar } from "./AgentAvatar";

export interface AgentAvatarGroupProps {
  agents: Agent[];
  size?: number;
  max?: number;
  label?: string;
  className?: string;
}

/**
 * Stacked avatars for a group chat: the same overlap geometry and overflow chip
 * as before, with each member drawn by the Marble renderer seeded by agent ID.
 */
export function AgentAvatarGroup({
  agents,
  size = 32,
  max = 3,
  label,
  className,
}: AgentAvatarGroupProps) {
  const visible = agents.slice(0, max);
  const overflow = agents.length - visible.length;

  return (
    <div
      data-slot="agent-avatar-group"
      role={label ? "img" : undefined}
      aria-label={label}
      className={cn("flex items-center", className)}
    >
      {visible.map((agent, index) => (
        <span
          key={agent.id}
          className="rounded-full bg-background p-0.5 ring-1 ring-background"
          style={{ marginLeft: index === 0 ? 0 : -size * 0.3 }}
        >
          <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={size} />
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="flex items-center justify-center rounded-full bg-muted text-2xs font-medium text-muted-foreground ring-1 ring-background"
          style={{ width: size, height: size, marginLeft: -size * 0.3 }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
