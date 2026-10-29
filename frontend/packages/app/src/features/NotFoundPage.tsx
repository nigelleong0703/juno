import { Button, EmptyState } from "@agent-desktop/ui";
import { useNavigate } from "react-router";
import { t } from "../lib/i18n";

/** Fallback for an unknown route. */
export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div data-titlebar className="flex h-[var(--shell-header-height)] shrink-0 items-center px-4">
        <span className="text-sm font-semibold text-fg">{t("detail.notFound")}</span>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState centered
          title={t("detail.notFound")}
          description={t("detail.notFoundHint")}
          action={
            <Button variant="secondary" onClick={() => navigate("/")}>
              {t("detail.backToChats")}
            </Button>
          }
        />
      </div>
    </div>
  );
}
