import type { RoutineItem } from "../../lib/items";
import { cn } from "@agent-desktop/ui";
import { Workflow } from "lucide-react";
import { useRoutine } from "../../data/queries";
import { t } from "../../lib/i18n";
import { routineStatusMeta } from "../../lib/status";
import { TriggerSummary } from "../routine/TriggerSummary";

export interface RoutineItemProps {
  item: RoutineItem;
  onOpen?: (routineId: string) => void;
  className?: string;
}

/** "Juno created a routine" card, embedded in the transcript. */
export function RoutineItem({ item, onOpen, className }: RoutineItemProps) {
  const { data: routine } = useRoutine(item.routineId);
  if (!routine) return null;

  const meta = routineStatusMeta[routine.status];

  return (
    <div className={cn("py-1", className)}>
      <button
        type="button"
        onClick={() => onOpen?.(routine.id)}
        className="flex w-full flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:bg-bg-subtle focus-ring"
      >
        <div className="flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-bg-subtle text-fg-muted">
            <Workflow className="size-3.5" />
          </span>
          <span className="text-sm font-medium text-fg">{routine.name}</span>
          {/* Coordinator feedback 2026-10-05: one muted line instead of two competing pills. */}
          <span className="ml-auto shrink-0 text-xs text-fg-muted">
            {t(item.change === "created" ? "routine.change.created" : "routine.change.updated")}
            {" · "}
            {t(meta.label)}
          </span>
        </div>
        <TriggerSummary routine={routine} />
      </button>
    </div>
  );
}
