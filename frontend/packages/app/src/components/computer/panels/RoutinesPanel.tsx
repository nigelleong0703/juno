import type { Routine } from "@agent-desktop/client";
import { cn, EmptyState, RelativeTime, StatusPill, Switch } from "@agent-desktop/ui";
import { useToggleRoutine } from "../../../data/mutations";
import { useRoutines } from "../../../data/queries";
import { routineRuns, routineStatusMeta, statusLabel } from "../../../lib/status";
import { TriggerSummary } from "../../routine/TriggerSummary";
import { tc } from "../i18n";
import { CARD_RADIUS, roundedSurface } from "../surface";

export interface RoutinesPanelProps {
  agentId: string;
  /** The agent's name, for the "Ask {Agent} in chat" hint. */
  agentName?: string;
  /**
   * Scope chat-delivered routines to this conversation. Routines belong to the
   * agent schedule; the tab beside Chat files only lists chat routines whose
   * delivery target is the conversation in view. Legacy chat routines without
   * a target are explained, never assumed to belong here.
   */
  conversationId?: string;
  /**
   * Default-view rows are one line each (status, name, toggle) and open the full cards.
   * The full cards — trigger summary, next/last runs, toggles — live in the secondary detail.
   */
  variant?: "full" | "compact";
  /** Open the full-card detail (compact rows only). */
  onOpenDetails?: () => void;
  className?: string;
}

/**
 * "Routines" tab (§修订 v0.3): the primary UI for an agent's routines. Lists each routine with its
 * trigger summary, next run, last result and an enable toggle. Authoring happens in chat, so the
 * empty state points the user there.
 */
export function RoutinesPanel({
  agentId,
  agentName = "the agent",
  conversationId,
  variant = "full",
  onOpenDetails,
  className,
}: RoutinesPanelProps) {
  const { data: routines, isLoading } = useRoutines({ agentId });
  const toggle = useToggleRoutine();

  // The list endpoint may ignore its agent filter and return every agent's routines; scope
  // locally so one agent's pane never shows another agent's schedules.
  const mine = (routines ?? []).filter((routine) => routine.agentId === agentId);

  // Chat delivery is conversation-scoped: only chat routines targeted at the
  // conversation in view belong in its tab. Non-chat deliveries (Slack, email)
  // are addressed elsewhere so they stay listed. Legacy chat routines without
  // a target are counted for the explanation below and never assumed current.
  const scoped =
    conversationId === undefined
      ? mine
      : mine.filter(
          (routine) => routine.delivery.channel !== "chat" || routine.delivery.target === conversationId,
        );
  const unscopedCount =
    conversationId === undefined
      ? 0
      : mine.filter((routine) => routine.delivery.channel === "chat" && !routine.delivery.target).length;
  const unscopedHint =
    unscopedCount > 0 ? (
      <p className="px-3 pt-1 text-xs text-fg-subtle">
        {tc("computer.routines.unscopedHint", { name: agentName })}
      </p>
    ) : null;

  const hint = <p className="px-3 pt-1 text-xs text-fg-subtle">{tc("computer.routines.askAgent", { name: agentName })}</p>;

  if (!isLoading && scoped.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title={tc("computer.routines.empty")}
          description={[tc("computer.routines.hint"), tc("computer.routines.askAgent", { name: agentName })].join(" ")}
        />
        {unscopedHint}
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <>
      <ul className={cn("px-3 py-1", className)} aria-label={tc("computer.tab.routines")}>
        {scoped.map((routine) => (
          <CompactRow
            key={routine.id}
            routine={routine}
            onOpen={onOpenDetails}
            onToggle={(enabled) => toggle.mutate({ id: routine.id, enabled })}
          />
        ))}
      </ul>
      {unscopedHint}
      </>
    );
  }

  return (
    <div className={cn("space-y-2 p-3", className)}>
      {scoped.map((routine) => (
        <RoutineRow
          key={routine.id}
          routine={routine}
          onToggle={(enabled) => toggle.mutate({ id: routine.id, enabled })}
        />
      ))}
      {hint}
      {unscopedHint}
    </div>
  );
}

/** One-line default-view row: status, truncated name, working toggle. Opens the full cards. */
function CompactRow({
  routine,
  onOpen,
  onToggle,
}: {
  routine: Routine;
  onOpen?: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const meta = routineStatusMeta[routine.status];
  const Icon = meta.icon;
  const failed = routine.lastRunStatus === "failed";
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={onOpen}
        style={roundedSurface(CARD_RADIUS)}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-interactive-hover active:bg-interactive-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <Icon className={cn("size-3.5 shrink-0", failed ? "text-danger" : "text-fg-subtle")} />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{routine.name}</span>
      </button>
      <Switch
        checked={routineRuns(routine)}
        disabled={routine.status === "needs_setup"}
        onCheckedChange={onToggle}
        aria-label={routine.name}
      />
    </li>
  );
}

function RoutineRow({
  routine,
  onToggle,
}: {
  routine: Routine;
  onToggle: (enabled: boolean) => void;
}) {
  const meta = routineStatusMeta[routine.status];
  const Icon = meta.icon;
  return (
    <div
      style={roundedSurface(CARD_RADIUS)}
      className="space-y-2 border border-border bg-surface px-2.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{routine.name}</span>
        <StatusPill
          tone={meta.tone}
          size="sm"
          icon={<Icon className="size-3" />}
          label={statusLabel(meta)}
        />
        <Switch
          checked={routineRuns(routine)}
          disabled={routine.status === "needs_setup"}
          onCheckedChange={onToggle}
          aria-label={routine.name}
        />
      </div>
      <TriggerSummary routine={routine} />
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-subtle">
        {routine.nextRunAt && (
          <span>
            {tc("computer.routines.nextRun")} <RelativeTime date={routine.nextRunAt} />
          </span>
        )}
        {routine.lastRunAt && (
          <span className={routine.lastRunStatus === "failed" ? "text-danger" : undefined}>
            {tc("computer.routines.lastResult")} <RelativeTime date={routine.lastRunAt} />
          </span>
        )}
      </div>
    </div>
  );
}
