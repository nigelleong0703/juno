import type { Agent } from "@agent-desktop/client";
import { Button } from "@agent-desktop/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useRoutines } from "../../../data/queries";
import { t } from "../../../lib/i18n";
import { AutomationList } from "../../automations/AutomationList";
import { NewRoutineDialog } from "../../routines/NewRoutineDialog";

/** Automations: this agent's routines, each with an on/off switch and a Delete. */
export function AutomationsTab({ agent }: { agent: Agent }) {
  const { data: routines, isLoading } = useRoutines({ agentId: agent.id });
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-1 px-2">
      {isLoading ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : !routines?.length ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("agentCard.schedules.empty")}</p>
      ) : (
        <AutomationList routines={routines} />
      )}
      <div className="flex justify-center pt-2">
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus /> {t("agentCard.automations.new")}
        </Button>
      </div>
      <NewRoutineDialog open={creating} onOpenChange={setCreating} defaultAgentId={agent.id} />
    </div>
  );
}
