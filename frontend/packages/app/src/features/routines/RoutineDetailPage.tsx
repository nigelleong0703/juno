import { ErrorState, LoadingState } from "@agent-desktop/ui";
import { ChevronLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { PageAction, PageFrame } from "../../components/page/PageFrame";
import { useRoutine } from "../../data/queries";
import { t } from "../../lib/i18n";
import { RoutineEditor } from "./RoutineSheet";

/** Standalone routine detail (`/routines/:id`) — the deep-link twin of the detail sheet. */
export function RoutineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: routine, isLoading, isError, refetch } = useRoutine(id);

  return (
    <PageFrame title={routine?.name ?? t("automations.title")} back={<PageAction icon={ChevronLeft} label={t("common.back")} onClick={() => navigate("/automations")} />}>
      <div className="mx-auto flex w-full min-h-0 max-w-2xl flex-1 flex-col">
        {isLoading ? (
          <div className="p-6">
            <LoadingState label={t("common.loading")} />
          </div>
        ) : isError || !routine ? (
          <div className="p-6">
            <ErrorState
              title={t("common.error")}
              description="This routine could not be loaded."
              onRetry={() => void refetch()}
            />
          </div>
        ) : (
          <RoutineEditor key={routine.id} routine={routine} />
        )}
      </div>
    </PageFrame>
  );
}
