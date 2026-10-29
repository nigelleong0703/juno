import { Button, cn, Spinner } from "@agent-desktop/ui";
import { Play, RefreshCw, TriangleAlert } from "lucide-react";
import { tc } from "./i18n";
import { PILL } from "./surface";
import type { ScreenPresence } from "./modes";

export interface ScreenPlaceholderProps {
  presence: ScreenPresence;
  agentName?: string;
  /** Allocate this agent's display; shown for `missing`. */
  onStart?: () => void;
  /** Truthful local callbacks for the start action. */
  startPending?: boolean;
  startError?: string | null;
  /** Re-request the stream ticket; shown for `error`. */
  onRetry?: () => void;
  className?: string;
}

/**
 * Honest stand-in for the live screen when a real backend has nothing to draw yet (SB3). It never
 * invents a desktop: it names the state and offers the one action that moves it forward.
 */
export function ScreenPlaceholder({
  presence,
  agentName,
  onStart,
  startPending = false,
  startError = null,
  onRetry,
  className,
}: ScreenPlaceholderProps) {
  const name = agentName ?? "The agent";

  if (presence === "starting") {
    return (
      <div className={cn("flex h-full w-full flex-col items-center justify-center gap-2 text-white/80", className)}>
        <Spinner className="size-5" />
        <span className="text-xs">{tc("computer.screen.starting", { name })}</span>
      </div>
    );
  }

  if (presence === "error") {
    return (
      <div className={cn("flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-white/85", className)}>
        <TriangleAlert className="size-5 text-warning" />
        <span className="text-sm font-medium">{tc("computer.screen.error.title")}</span>
        <span className="text-xs text-white/65">{tc("computer.screen.error.body", { name })}</span>
        {onRetry && (
          <Button variant="secondary" size="sm" className={cn("mt-1 gap-1.5", PILL)} onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            {tc("computer.screen.retry")}
          </Button>
        )}
      </div>
    );
  }

  // `missing` (no display allocated yet) and `asleep` (display stopped) both offer to start it.
  return (
    <div className={cn("flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-white/80", className)}>
      <span className="text-sm font-medium">{tc("computer.screen.none.title")}</span>
      <span className="text-xs text-white/60">{tc("computer.screen.none.body", { name })}</span>
      {onStart && (
        <Button variant="secondary" size="sm" className={cn("mt-1 gap-1.5", PILL)} onClick={onStart} disabled={startPending}>
          {startPending ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
          {tc("computer.screen.start")}
        </Button>
      )}
      {startError && (
        <span role="alert" className="max-w-full truncate text-xs text-danger">
          {startError}
        </span>
      )}
    </div>
  );
}
