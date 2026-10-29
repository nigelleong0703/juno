import type { Routine } from "@agent-desktop/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ListRow,
  Switch,
  toast,
} from "@agent-desktop/ui";
import { CalendarClock, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { RoutineSetupNote } from "../../components/routine";
import { useToggleRoutine } from "../../data/mutations";
import { useDeleteRoutine } from "../../data/routines";
import { t } from "../../lib/i18n";
import { routineRuns } from "../../lib/status";
import { ShowMore, useCapped } from "../agents/card/parts";
import { triggerText } from "../routines/RoutineSheet";

/** The shared Automations list: icon tile, title, schedule, switch, "…" menu with Delete + confirm, capped with Show more. */
export function AutomationList({ routines, limit = 12, onOpen }: { routines: Routine[]; limit?: number; onOpen?: (routine: Routine) => void }) {
  const toggleRoutine = useToggleRoutine();
  const deleteRoutine = useDeleteRoutine();
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const capped = useCapped(routines, limit);

  const confirmDelete = () => {
    if (!deleting) return;
    deleteRoutine.mutate(deleting.id, { onError: () => toast.error(t("common.error")) });
    setDeleting(null);
  };

  return (
    <>
      {capped.shown.map((routine) => {
        const needsSetup = routine.status === "needs_setup";
        return (
          <div key={routine.id}>
            <ListRow
              {...(onOpen ? { onClick: () => onOpen(routine) } : {})}
              leading={
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <CalendarClock className="size-[18px]" />
                </span>
              }
              title={routine.name}
              description={triggerText(routine)}
              trailing={
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  <Switch
                    checked={routineRuns(routine)}
                    disabled={needsSetup}
                    aria-label={t("agentCard.schedules.toggle", { name: routine.name })}
                    onCheckedChange={(enabled) => toggleRoutine.mutate({ id: routine.id, enabled })}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={t("agentCard.automations.more")}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(routine)}>
                        <Trash2 /> {t("common.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              }
            />
            <RoutineSetupNote routine={routine} className="pb-2 pl-14 pr-2" />
          </div>
        );
      })}
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{deleting?.name}</AlertDialogTitle>
          <AlertDialogDescription>{t("agentCard.automations.confirm")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{t("common.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
