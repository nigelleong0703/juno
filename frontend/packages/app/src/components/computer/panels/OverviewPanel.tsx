import type { Run } from "@agent-desktop/client";
import { cn, EmptyState, RelativeTime } from "@agent-desktop/ui";
import { Activity } from "lucide-react";
import { useRuns } from "../../../data/queries";
import { RunStatusPill } from "../../run/RunStatusPill";
import { tc } from "../i18n";
import { CARD_RADIUS, roundedSurface } from "../surface";

export interface OverviewPanelProps {
  agentId: string;
  /** Open the task thread for a run (wired by `ComputerPane`). */
  onOpenRun?: (runId: string) => void;
  className?: string;
}

const ACTIVE_STATUSES = new Set<Run["status"]>(["running", "waiting_for_input", "queued"]);

/**
 * "Overview" tab (§6): the agent's current task and its recent runs, read straight from the run
 * cache that the live stream keeps warm.
 */
export function OverviewPanel({ agentId, onOpenRun, className }: OverviewPanelProps) {
  const { data: runs, isLoading } = useRuns({ agentId });

  const sorted = [...(runs ?? [])].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
  const current = sorted.find((run) => ACTIVE_STATUSES.has(run.status));
  const recent = sorted.filter((run) => run.id !== current?.id).slice(0, 6);

  return (
    <div className={cn("space-y-4 p-3", className)}>
      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
          {tc("computer.overview.currentTask")}
        </h3>
        {current ? (
          <RunRow run={current} onOpen={onOpenRun} />
        ) : (
          <p className="text-sm text-fg-muted">{tc("computer.overview.noTask")}</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
          {tc("computer.overview.recentRuns")}
        </h3>
        {isLoading ? (
          <p className="text-sm text-fg-muted">…</p>
        ) : recent.length === 0 ? (
          <EmptyState centered
            title={tc("computer.overview.noRuns")}
            className="py-6"
          />
        ) : (
          <ul className="space-y-1.5">
            {recent.map((run) => (
              <li key={run.id}>
                <RunRow run={run} onOpen={onOpenRun} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunRow({ run, onOpen }: { run: Run; onOpen?: (runId: string) => void }) {
  return (
    <button
      type="button"
      onClick={onOpen ? () => onOpen(run.id) : undefined}
      style={roundedSurface(CARD_RADIUS)}
      className={cn(
        "flex w-full items-center gap-2 border border-border bg-bg px-2.5 py-2 text-left",
        onOpen && "hover:bg-accent-subtle",
      )}
    >
      <Activity className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{run.title}</span>
      <RelativeTime date={run.lastActivityAt} className="shrink-0 text-xs" />
      <RunStatusPill status={run.status} />
    </button>
  );
}
