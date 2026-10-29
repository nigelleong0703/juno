import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, toast } from "@agent-desktop/ui";
import type { PlatformMyMac } from "../../platform/adapter";
import { t } from "../../lib/i18n";
import { Row } from "./SettingsGroup";

/** Local permission/setup controls use the same rows as the existing Mac settings. */
export function MyMacDesktopRows({ mac }: { mac: PlatformMyMac }) {
  const [busy, setBusy] = useState(false);
  const status = useQuery({
    queryKey: ["platform", "my-mac-desktop"],
    queryFn: () => mac.desktopStatus?.(),
    enabled: mac.desktopStatus !== undefined,
    refetchInterval: 5000,
  });
  const run = async (action: () => Promise<void> | undefined) => {
    setBusy(true);
    try {
      await action();
      await status.refetch();
    } catch (error) {
      toast(error instanceof Error ? error.message : t("myMac.failed"));
    } finally {
      setBusy(false);
    }
  };
  if (!mac.desktopStatus) return null;
  const state = status.data;
  const permission = (kind: "screen" | "accessibility", allowed: boolean | undefined) => (
    <Button variant="secondary" size="sm" disabled={busy || !mac.requestPermission} onClick={() => void run(() => mac.requestPermission?.(kind))}>
      {allowed ? t("myMac.desktop.settings") : t("myMac.desktop.enable")}
    </Button>
  );
  return (
    <>
      <Row label={t("myMac.desktop.screen")} description={state?.detail ?? (state?.screen ? t("myMac.desktop.allowed") : t("myMac.desktop.screenHint"))}>
        {permission("screen", state?.screen)}
      </Row>
      <Row label={t("myMac.desktop.accessibility")} description={state?.accessibility ? t("myMac.desktop.allowed") : t("myMac.desktop.accessibilityHint")}>
        {permission("accessibility", state?.accessibility)}
      </Row>
      <Row label={t("myMac.desktop.chrome")} description={state?.chrome ? t("myMac.desktop.chromeConnected") : t("myMac.desktop.chromeHint")}>
        <Button variant="secondary" size="sm" disabled={busy || !mac.setupChrome} onClick={() => void run(() => mac.setupChrome?.())}>
          {t("myMac.desktop.setup")}
        </Button>
      </Row>
      <Row label={t("myMac.desktop.audio")} description={t("myMac.desktop.audioHint")}>
        <span className="text-xs text-fg-muted">{state?.audio ? t("myMac.desktop.ready") : t("myMac.desktop.permissionNeeded")}</span>
      </Row>
    </>
  );
}
