import type { HandoffItem } from "../../lib/items";
import { cn } from "@agent-desktop/ui";
import { ArrowLeftRight } from "lucide-react";
import { formatDuration } from "../../lib/format";
import { t } from "../../lib/i18n";

export interface HandoffMarkerProps {
  item: HandoffItem;
  agentName?: string;
  className?: string;
}

/** Centered divider marking a control hand-off between the user and the agent (§4.3). */
export function HandoffMarker({ item, agentName = "the agent", className }: HandoffMarkerProps) {
  const label =
    item.direction === "to_user"
      ? t("handoff.toUser")
      : t("handoff.toAgent", { name: agentName });

  return (
    <div className={cn("flex items-center gap-3 py-2", className)}>
      <span className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg-muted">
        <ArrowLeftRight className="size-3.5 text-fg-subtle" />
        {label}
        {item.durationMs !== undefined && (
          <span className="text-fg-subtle">
            · {t("handoff.away", { duration: formatDuration(item.durationMs) })}
          </span>
        )}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
