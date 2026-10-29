import type { MacAppAccess } from "@agent-desktop/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  Button,
  toast,
} from "@agent-desktop/ui";
import { useState } from "react";
import { useMacApps, useRevokeMacApp } from "../../data/my-mac";
import { formatAgo } from "../../lib/format";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";
import { Group } from "./SettingsGroup";

/** Apps per page before "Show more". */
const APPS_PAGE = 5;

const dayLabel = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** "Apps agents may use": the apps the owner chose "Always allow" for, each with the date and when it was last used; Remove asks first. */
export function MyMacApps() {
  const apps = useMacApps().data?.apps;
  const revoke = useRevokeMacApp();
  const [removing, setRemoving] = useState<MacAppAccess | null>(null);
  const capped = useCapped(apps ?? [], APPS_PAGE);
  if (apps === undefined) return null;

  const confirmRemove = () => {
    if (removing) revoke.mutate(removing.app, { onError: () => toast(t("myMac.failed")) });
    setRemoving(null);
  };

  return (
    <>
      <Group title={t("myMac.apps.title")}>
        {apps.length === 0 ? (
          <p className="px-2.5 py-2 text-sm text-fg-subtle">{t("myMac.apps.empty")}</p>
        ) : (
          capped.shown.map((entry) => (
            <div key={entry.app} className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-fg">{entry.name}</div>
                <div className="text-xs text-fg-subtle">
                  {[t("myMac.apps.allowed", { date: dayLabel(entry.allowedAt) }), entry.lastUsedAt ? t("myMac.apps.used", { date: formatAgo(entry.lastUsedAt) }) : ""].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button variant="secondary" size="sm" disabled={revoke.isPending} onClick={() => setRemoving(entry)}>
                {t("myMac.apps.remove")}
              </Button>
            </div>
          ))
        )}
        <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
      </Group>
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("myMac.apps.remove")}</AlertDialogTitle>
          <AlertDialogDescription>{removing ? t("myMac.apps.confirm", { name: removing.name }) : ""}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove}>{t("myMac.apps.remove")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
