import type { AppProblem } from "@agent-desktop/client";
import { Button, toast } from "@agent-desktop/ui";
import { useNavigate } from "react-router";
import { useApps, useInstallApp, useOpenInstall, useSetAgentApp } from "../../data/apps";
import { useAgent } from "../../data/queries";
import { appProblem, connectAction, expiredInstallation } from "../../lib/apps";
import { t } from "../../lib/i18n";

/** Needs a routine can declare that are not apps the owner adds: shown by label only. */
const NOT_ADDABLE = new Set(["web_search", "computer"]);

/** The options of a missing requirement the owner can actually act on. */
export const addableIds = (options: string[]): string[] => options.filter((id) => !NOT_ADDABLE.has(id));

/**
 * The one action for an app an agent needs, by why it cannot use it: not added opens the app to add it, added but off for
 * this agent turns it on, a sign-in that never worked, was rejected or lacks a permission reconnects. `problem` comes from the connect card; without it the list decides.
 * Shared by the chat connect card and routine rows.
 */
export function AppAction({
  appId,
  agentId,
  problem,
  size = "xs",
  disabled,
  className,
}: {
  appId: string;
  agentId: string;
  problem?: AppProblem | undefined;
  size?: "xs" | "sm";
  disabled?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const { data: apps } = useApps();
  const { data: agent } = useAgent(agentId);
  const install = useInstallApp();
  const openInstall = useOpenInstall();
  const setAgentApp = useSetAgentApp();
  const app = apps?.find((entry) => entry.id === appId);
  const name = app?.name ?? appId;
  const action = connectAction(problem ?? appProblem(app, agentId) ?? undefined);
  const failed = (error: unknown) => toast.error(error instanceof Error && error.message ? error.message : t("common.error"));

  const run = () => {
    if (action === "add") {
      navigate(`/apps/${encodeURIComponent(appId)}`);
    } else if (action === "turn-on") {
      setAgentApp.mutate({ agentId, appId, enabled: true }, { onSuccess: () => toast(t("connect.turnedOn", { name })), onError: failed });
    } else {
      const expired = app ? expiredInstallation(app) : undefined;
      // An app that asks for values (an API key) is signed in again from its own page.
      if (!app || !expired || app.userConfig.length > 0) {
        navigate(`/apps/${encodeURIComponent(appId)}`);
        return;
      }
      install.mutate({ appId, input: { connectionId: expired.id } }, { onSuccess: (response) => openInstall(response, name), onError: failed });
    }
  };

  const label = action === "add" ? t("connect.addApp", { name }) : action === "turn-on" ? t("connect.turnOn", { agent: agent?.name ?? "" }) : t("connect.reconnect");
  return (
    <Button variant="secondary" size={size} className={className ?? "rounded-full"} disabled={disabled || install.isPending || setAgentApp.isPending || app?.available === false} onClick={run}>
      {label}
    </Button>
  );
}
