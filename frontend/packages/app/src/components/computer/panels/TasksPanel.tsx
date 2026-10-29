import type { Todo } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { CircleAlert, CircleDashed, Loader2, type LucideIcon } from "lucide-react";
import { useAgentPlans } from "../../../data/tasks";
import { tc } from "../i18n";
import { CARD_RADIUS, roundedSurface } from "../surface";
import { selectOngoingTasks, type OngoingTask } from "./ongoingTasks";

export interface TasksPanelProps {
  agentId: string;
  className?: string;
}

interface TodoGlyph {
  icon: LucideIcon;
  label: string;
  className: string;
}

function todoGlyph(status: Todo["status"]): TodoGlyph {
  switch (status) {
    case "in_progress":
      return {
        icon: Loader2,
        label: "computer.tasks.status.inProgress",
        className: "text-accent animate-spin",
      };
    case "blocked":
      return { icon: CircleAlert, label: "computer.tasks.status.blocked", className: "text-warning" };
    default:
      return { icon: CircleDashed, label: "computer.tasks.status.pending", className: "text-fg-subtle" };
  }
}

function TaskRow({ row }: { row: OngoingTask }) {
  const glyph = todoGlyph(row.todo.status);
  const Icon = glyph.icon;
  return (
    <li
      style={roundedSurface(CARD_RADIUS)}
      className="flex w-full items-start gap-2 border border-border bg-surface px-2.5 py-2"
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", glyph.className)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">{row.todo.text}</p>
        <p className="mt-0.5 text-xs text-fg-subtle">{tc(glyph.label)}</p>
        {row.todo.note && <p className="mt-0.5 text-xs text-fg-subtle">{row.todo.note}</p>}
      </div>
    </li>
  );
}

/**
 * Ongoing tasks under the Computer screen: the agent's unfinished todos, read from the
 * authoritative plan endpoint (TODO-LIFECYCLE). Quiet when nothing is outstanding, never a
 * fabricated task from run history.
 */
export function TasksPanel({ agentId, className }: TasksPanelProps) {
  const { data, isError, isLoading } = useAgentPlans(agentId);
  const rows = selectOngoingTasks(data ?? [], agentId);

  return (
    <section aria-label={tc("computer.tasks.title")} className={cn("pb-4", className)}>
      <h3 className="px-4 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">
        {tc("computer.tasks.title")}
      </h3>
      {isError ? (
        <p className="px-4 text-sm text-fg-muted">{tc("computer.tasks.error")}</p>
      ) : isLoading ? (
        <p className="px-4 text-sm text-fg-muted">{tc("computer.tasks.loading")}</p>
      ) : rows.length === 0 ? (
        // A quiet line under the panel heading, not a page-sized empty state.
        <p className="px-4 text-sm text-fg-muted">{tc("computer.tasks.empty")}</p>
      ) : (
        <ul className="space-y-1.5 px-4">
          {rows.map((row) => (
            // Todo ids are only unique within a plan; scope the key by conversation so two
            // conversations that reuse the same todo id never collide. `JSON.stringify` of the
            // pair is collision-free for arbitrary id strings (no separator ambiguity).
            <TaskRow key={JSON.stringify([row.conversationId, row.todo.id])} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}
