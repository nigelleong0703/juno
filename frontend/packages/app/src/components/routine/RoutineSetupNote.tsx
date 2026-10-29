import type { Routine } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { t } from "../../lib/i18n";
import { AppAction, addableIds } from "../connect/AppAction";

/**
 * Under a routine that cannot run yet: "Needs setup: connect <label>" and a Connect button per app that would satisfy
 * it (web search and the computer are named, not connectable). Renders nothing for a routine that is set up.
 */
export function RoutineSetupNote({ routine, className }: { routine: Routine; className?: string }) {
  if (routine.status !== "needs_setup" || !routine.missing?.length) return null;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {routine.missing.map((need) => (
        <div key={need.capability} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-sm text-warning">{t("routines.needsSetup", { label: need.label })}</span>
          {addableIds(need.options).map((id) => (
            <AppAction key={id} appId={id} agentId={routine.agentId} />
          ))}
        </div>
      ))}
    </div>
  );
}
