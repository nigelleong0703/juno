import type { FileSnapshot, Step } from "@agent-desktop/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  Button,
  ListRow,
} from "@agent-desktop/ui";
import { History } from "lucide-react";
import { useState } from "react";
import { useFileHistory, useRestoreFile } from "../../../data/file-history";
import { formatBytes } from "../../../lib/format";
import { t } from "../../../lib/i18n";
import { stepFile } from "../../../lib/stepLine";
import { ShowMore, dayLabel, timeLabel, useCapped } from "./parts";

/** Versions listed before "Show more". */
const VERSIONS_PAGE = 5;

/**
 * Under an opened `files.write` / `files.edit` step: the earlier versions of that file ("Versions"), newest first, each with Restore.
 * Restore asks first and keeps the current version, so it can be undone. Nothing shows when no earlier version is kept.
 */
export function FileVersions({ step, agentId }: { step: Step; agentId: string }) {
  const file = stepFile(step);
  if (!file) return null;
  return <Versions agentId={agentId} path={file.path} on={file.on} />;
}

function Versions({ agentId, path, on }: { agentId: string; path: string; on: "sandbox" | "mac" }) {
  const { data } = useFileHistory(agentId, path, on);
  const restore = useRestoreFile(agentId, path);
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState<FileSnapshot | null>(null);
  const capped = useCapped(data ?? [], VERSIONS_PAGE);
  if (!data || data.length === 0) return null;
  return (
    <div className="flex flex-col pb-2.5">
      <Button variant="ghost" size="xs" className="w-fit" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <History aria-hidden />
        {t("fileVersions.title")}
      </Button>
      {open ? (
        <>
          <ul aria-label={t("fileVersions.title")}>
            {capped.shown.map((snapshot) => (
              <li key={snapshot.id}>
                <ListRow
                  dense
                  title={`${dayLabel(snapshot.createdAt)}, ${timeLabel(snapshot.createdAt)}`}
                  meta={formatBytes(snapshot.sizeBytes)}
                  trailing={
                    <Button variant="secondary" size="xs" disabled={restore.isPending} onClick={() => setAsked(snapshot)}>
                      {t("fileVersions.restore")}
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
          <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
        </>
      ) : null}
      <AlertDialog open={asked !== null} onOpenChange={(next) => !next && setAsked(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("fileVersions.confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("fileVersions.confirmBody")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => asked && restore.mutate(asked)}>{t("fileVersions.restore")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
