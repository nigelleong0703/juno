import { EmptyState } from "@agent-desktop/ui";
import { t } from "../../lib/i18n";

/** Shown in place of People or Memory while the backend route is not there yet (the 404 feature check). */
export function TeamComingSoon() {
  return <EmptyState title={t("team.comingSoon")} description={t("team.comingSoonHint")} />;
}
