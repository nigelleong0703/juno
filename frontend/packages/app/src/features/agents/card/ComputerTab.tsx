import type { Agent } from "@agent-desktop/client";
import { Button } from "@agent-desktop/ui";
import { Monitor } from "lucide-react";
import { t } from "../../../lib/i18n";
import { useUiStore } from "../../../store/ui";

/** Computer: the iPhone's tab. Its picture is the workspace pane on desktop, so this says so when empty and opens the pane. */
export function ComputerTab({ agent }: { agent: Agent }) {
  const openWorkspace = useUiStore((state) => state.openWorkspace);
  return (
    <div className="flex flex-col items-start gap-3 px-4">
      <p className="text-sm text-fg-muted">{t("agentCard.computer.empty")}</p>
      <Button variant="outline" size="sm" onClick={() => openWorkspace(agent.id)}>
        <Monitor /> {t("agentCard.computer.open")}
      </Button>
    </div>
  );
}
