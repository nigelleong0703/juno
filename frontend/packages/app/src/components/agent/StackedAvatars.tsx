import type { Agent } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { AgentAvatar } from "./AgentAvatar";

export interface StackedAvatarsProps {
  agents: Agent[];
  slot: number;
  label?: string;
  className?: string;
}

/**
 * A group chat avatar: two members on a diagonal, one top-left and one
 * bottom-right, inside the same square slot as a single avatar. At 0.575 times
 * the slot the two never touch, so no separating ring is needed. No overflow
 * chip: the room name and member list carry the count.
 */
export function StackedAvatars({ agents, slot, label, className }: StackedAvatarsProps) {
  const pair = agents.slice(0, 2);
  const shape = Math.round(slot * 0.575);

  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      className={cn("relative flex shrink-0", className)}
      style={{ width: slot, height: slot }}
    >
      {pair.map((agent, index) => {
        const offset = pair.length === 1 ? (slot - shape) / 2 : index === 0 ? 0 : slot - shape;
        return (
          <span
            key={agent.id}
            className="absolute flex overflow-hidden rounded-full"
            style={{ left: offset, top: offset, width: shape, height: shape }}
          >
            <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={shape} />
          </span>
        );
      })}
    </span>
  );
}
