import type { Agent, Computer } from "@agent-desktop/client";
import { Button, cn } from "@agent-desktop/ui";
import { ArrowUpRight } from "lucide-react";
import { LiveScreen } from "./LiveScreen";
import { ComputerStatePill } from "./ComputerStatePill";
import { tc } from "./i18n";
import { CARD_RADIUS, roundedSurface, SCREEN_RADIUS } from "./surface";
import type { LiveScreenTarget } from "./types";

export interface ComputerPreviewCardProps {
  computer: Computer;
  agent?: Agent;
  /** When set, the thumbnail mounts a real noVNC session; otherwise it shows no picture. */
  target?: LiveScreenTarget | null;
  onOpen?: () => void;
  className?: string;
}

/**
 * Inline preview (§修订 v0.2 "inline ComputerPreviewCard"): a small live thumbnail with the
 * computer's state and an "Open" affordance that focuses the Computer pane.
 *
 * Usage (E1) — drop it inline wherever the conversation should show what the agent's screen is
 * doing (e.g. above a run thread or in a message that references the computer). It is exported
 * from `@agent-desktop/app`:
 *
 * ```tsx
 * import { ComputerPreviewCard } from "@agent-desktop/app";
 *
 * const { computer } = useAgentComputer(agentId);
 * // …
 * <ComputerPreviewCard
 *   computer={computer}
 *   agent={agent}
 *   target={streamTarget}
 *   onOpen={() => openComputerPane()}   // focus/expand the right pane (or navigate to the run)
 * />
 * ```
 *
 * Pass `target` only when a real noVNC endpoint exists; without it the card shows nothing rather
 * than fabricating a screen. Keep it inside a width-constrained container — the card sizes to its
 * parent and holds the 1364:1024 ratio itself.
 */
export function ComputerPreviewCard({
  computer,
  agent,
  target,
  onOpen,
  className,
}: ComputerPreviewCardProps) {
  return (
    <div
      className={cn("overflow-hidden border border-border bg-bg p-1.5", className)}
      style={roundedSurface(CARD_RADIUS)}
    >
      <div
        className="relative w-full overflow-hidden bg-black"
        style={roundedSurface(SCREEN_RADIUS, { aspectRatio: "1364 / 1024" })}
      >
        <LiveScreen
          computer={computer}
          target={target}
          viewOnly
        />
      </div>
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          {tc("computer.preview.title", { name: agent?.name ?? computer.name })}
        </span>
        <ComputerStatePill state={computer.state} size="sm" />
        <Button variant="ghost" size="sm" className="gap-1" onClick={onOpen}>
          {tc("computer.preview.open")}
          <ArrowUpRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
