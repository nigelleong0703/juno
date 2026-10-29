import { Button, EmptyState, ErrorState, LoadingState, ScrollArea, SearchField, SegmentedControl } from "@agent-desktop/ui";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { AgentScopeButton } from "../../components/agent/AgentScopeButton";
import { PageFrame } from "../../components/page/PageFrame";
import { useAgents, useRoutines } from "../../data/queries";
import { t } from "../../lib/i18n";
import { NewRoutineDialog } from "../routines/NewRoutineDialog";
import { triggerText } from "../routines/RoutineSheet";
import { AutomationCalendar } from "./AutomationCalendar";
import { AutomationList } from "./AutomationList";
import { slotCron } from "./occurrences";

/** The search pill only earns its place once the list is long. */
const SEARCH_FROM = 12;

type View = "calendar" | "list";
const VIEW_KEY = "automations.view";

function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "calendar";
  } catch {
    return "calendar";
  }
}

/**
 * Automations: every agent's routines in one list (same rows as the agent card), scoped by agent.
 * A row opens the routine's detail page.
 */
export function AutomationsPage() {
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [slot, setSlot] = useState<Date | null>(null);
  const [view, setView] = useState<View>(storedView);
  const { data: agents } = useAgents();
  const routines = useRoutines();

  const all = useMemo(
    () => (routines.data ?? []).filter((routine) => agentId === "all" || routine.agentId === agentId),
    [routines.data, agentId],
  );
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((routine) => `${routine.name} ${triggerText(routine)}`.toLowerCase().includes(needle)) : all;
  }, [all, query]);

  const changeView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Remembering the choice is a convenience only.
    }
  };
  const openRoutine = (routine: { id: string }) => navigate(`/automations/${routine.id}`);
  const calendar = view === "calendar";

  return (
    <PageFrame
      title={t("automations.title")}
      scope={<AgentScopeButton bubble agents={agents} value={agentId} onChange={setAgentId} />}
      actions={
        <>
          <SegmentedControl
            aria-label={t("automations.view")}
            value={view}
            onValueChange={(value) => changeView(value as View)}
            items={[
              { value: "calendar", label: t("automations.view.calendar") },
              { value: "list", label: t("automations.view.list") },
            ]}
          />
          <Button variant="ghost" size="icon" aria-label={t("agentCard.automations.new")} title={t("agentCard.automations.new")} className="size-8 rounded-full text-fg-muted" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
          </Button>
        </>
      }
    >
      {!calendar && all.length >= SEARCH_FROM ? (
        <div className="px-5 pb-4">
          <SearchField className="w-60" size="sm" value={query} onValueChange={setQuery} placeholder={t("automations.search")} />
        </div>
      ) : null}
      {calendar && !routines.isLoading && !routines.isError ? (
        <AutomationCalendar routines={all} agents={agents} {...(agentId === "all" ? {} : { agentId })} onOpen={openRoutine} onSlot={setSlot} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl space-y-1 px-4 pb-10 lg:mx-0">
            {routines.isLoading ? (
              <LoadingState label={t("common.loading")} />
            ) : routines.isError ? (
              <ErrorState title={t("common.error")} onRetry={() => void routines.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState title={t("automations.empty")} description={t("automations.emptyHint")} />
            ) : (
              <AutomationList routines={rows} onOpen={openRoutine} />
            )}
          </div>
        </ScrollArea>
      )}
      <NewRoutineDialog open={creating} onOpenChange={setCreating} {...(agentId === "all" ? {} : { defaultAgentId: agentId })} />
      <NewRoutineDialog
        key={slot?.getTime() ?? "none"}
        open={slot !== null}
        onOpenChange={(open) => !open && setSlot(null)}
        defaultCron={slot ? slotCron(slot) : ""}
        {...(agentId === "all" ? {} : { defaultAgentId: agentId })}
      />
    </PageFrame>
  );
}
