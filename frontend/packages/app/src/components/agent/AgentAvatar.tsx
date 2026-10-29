import type { AgentStatus, AvatarSpec } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { CHARACTERS, type CharacterState } from "../../characters";
import { CharacterAvatar } from "./CharacterAvatar";
import { agentCharacter } from "../../lib/avatars";

/**
 * Agent avatar: one of the six fluffy characters (`avatar.character`, else a stable pick from the agent
 * id - lib/avatars.ts). Same rule as the iPhone app: a poster at rest; the clip comes only from the agent's
 * status (working, needs_you, sleeping/paused, error -> failed) and loops from 40px. Idle shows the poster.
 * No hover or "active" animation; prefers-reduced-motion keeps every avatar on the poster. The status dot
 * appears only while working. Atlases load lazily on first play.
 */

export interface AgentAvatarProps {
  agentId: string;
  avatar?: AvatarSpec;
  status?: AgentStatus;
  /** Amber dot (the agent waits on the user), shown instead of the working dot. */
  needsYou?: boolean;
  size?: AgentAvatarSize | number;
  flat?: boolean;
  label?: string;
  dotRingClassName?: string;
  className?: string;
}

/** Character clip per agent status (identical to iOS Avatar.swift); idle and anything else rests on the poster. */
const STATUS_CLIP: Partial<Record<AgentStatus, CharacterState>> = {
  working: "working",
  needs_you: "needs_you",
  sleeping: "sleeping",
  paused: "sleeping",
  error: "failed",
};

/** Named sizes used across the app (VISUAL.md metrics). */
export const AVATAR_SIZE = {
  xs: 20,
  sm: 24,
  md: 32,
  lg: 40,
  xl: 64,
} as const;

export type AgentAvatarSize = keyof typeof AVATAR_SIZE;

export function AgentAvatar({
  agentId,
  avatar,
  status,
  needsYou,
  size = AVATAR_SIZE.md,
  label,
  dotRingClassName,
  className,
}: AgentAvatarProps) {
  const px = typeof size === "number" ? size : AVATAR_SIZE[size];
  const showDot = needsYou === true || status === "working";
  const sprite = CHARACTERS[agentCharacter(agentId, avatar)];
  const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const statusClip = status ? STATUS_CLIP[status] : undefined;
  const clip: CharacterState | null = reduceMotion || px < AVATAR_SIZE.lg || !statusClip ? null : statusClip;

  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: px, height: px }}
    >
      <CharacterAvatar sprite={sprite} px={px} clip={clip} />
      {showDot && (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 rounded-full ring-2",
            needsYou ? "bg-warning" : "bg-success",
            dotRingClassName ?? "ring-bg",
            px <= AVATAR_SIZE.sm ? "size-2" : "size-2.5",
          )}
        />
      )}
    </span>
  );
}
