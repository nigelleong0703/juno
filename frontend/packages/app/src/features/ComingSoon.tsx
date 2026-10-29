import { Button, EmptyState, PageHeader } from "@agent-desktop/ui";
import { useNavigate } from "react-router";
import { t } from "../lib/i18n";

export interface ComingSoonProps {
  title: string;
  subtitle?: string;
}

/**
 * Placeholder for §11 routes whose real screens land in the next milestone. It still renders the
 * page chrome so navigation, the sidebar and the header behave exactly as they will later.
 */
export function ComingSoon({ title, subtitle }: ComingSoonProps) {
  const navigate = useNavigate();

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <PageHeader title={title} subtitle={subtitle} />
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState centered
          title={t("coming.title")}
          description={t("coming.body")}
          action={
            <Button variant="secondary" onClick={() => navigate("/")}>
              {t("coming.back")}
            </Button>
          }
        />
      </div>
    </div>
  );
}
