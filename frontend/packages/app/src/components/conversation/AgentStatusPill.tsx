import { Button, cn } from "@agent-desktop/ui";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import type { AgentStatus } from "./deliveryState";

/** How long the pill stays mounted after its state clears, so the fade-out can play. */
export const EXIT_MS = 150;

export interface AgentStatusPillProps {
  status: AgentStatus | null;
  onRetry: (tempId: string) => void;
  onDelete: (tempId: string) => void;
}

/**
 * The agent-status pill: a small muted capsule directly above the composer that says why nothing
 * is moving (a refused send, a dropped connection). It never reports a working agent: that is the
 * typing bubble in the transcript. Renders nothing otherwise.
 */
export function AgentStatusPill({ status, onRetry, onDelete }: AgentStatusPillProps) {
  const { shown, leaving } = useLingering(status);
  if (shown === null) return null;

  return (
    <div data-slot="agent-status-row" className="relative z-[6] mx-auto flex w-full max-w-[760px] px-4 pb-1">
      <div
        role="status"
        aria-live="polite"
        data-slot="agent-status-pill"
        data-state={shown.kind}
        data-leaving={leaving ? "" : undefined}
        className={cn(
          "flex h-7 max-w-full min-w-0 items-center gap-2 rounded-full border px-2.5 text-[13px] leading-none",
          shown.kind === "failed" ? "border-danger/40 bg-danger-subtle text-danger" : "border-border bg-muted text-fg-muted",
          leaving ? "agent-status-pill-out" : "agent-status-pill-in",
        )}
      >
        {shown.kind === "failed" ? (
          <>
            <CircleAlert aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate" title={shown.reason}>
              {t("agentStatus.failed")}
            </span>
            <Button variant="ghost" size="sm" className="h-5 px-1.5 text-xs" onClick={() => onRetry(shown.tempId)}>
              {t("agentStatus.retry")}
            </Button>
            <Button variant="ghost" size="sm" className="h-5 px-1.5 text-xs" onClick={() => onDelete(shown.tempId)}>
              {t("agentStatus.delete")}
            </Button>
          </>
        ) : (
          <>
            <span className="min-w-0 truncate">{t("agentStatus.reconnecting")}</span>
            <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Keeps the last shown state for `EXIT_MS` after it clears, so the pill can fade out before it
 * unmounts. `leaving` is true only during that fade.
 */
function useLingering<T>(value: T | null): { shown: T | null; leaving: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) {
      setKept(value);
      return;
    }
    if (kept === null) return;
    const handle = setTimeout(() => setKept(null), EXIT_MS);
    return () => clearTimeout(handle);
  }, [value, kept]);
  if (value !== null) return { shown: value, leaving: false };
  return { shown: kept, leaving: kept !== null };
}
