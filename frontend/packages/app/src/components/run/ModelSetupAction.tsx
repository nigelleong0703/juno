import { Button } from "@agent-desktop/ui";
import { useInRouterContext, useNavigate } from "react-router";
import { isModelSetupError } from "../../data/model-providers";
import { t } from "../../lib/i18n";

/** "Open model settings" for a run failure that a model-provider setting fixes; nothing otherwise. */
export function ModelSetupAction({ error }: { error: string }) {
  const inRouter = useInRouterContext();
  if (!inRouter || !isModelSetupError(error)) return null;
  return <ModelSetupButton />;
}

function ModelSetupButton() {
  const navigate = useNavigate();
  return (
    <Button variant="secondary" size="sm" className="h-6 px-2 text-xs" onClick={() => navigate("/settings/models")}>
      {t("models.runError.open")}
    </Button>
  );
}
