import type { AuditEntry } from "@agent-desktop/client";
import { channelPlatformName } from "../components/channel/platforms";
import { t } from "./i18n";

/**
 * The "who started it" line under an activity row, from the entry's initiator (the root origin of its run). The wording is the same on
 * the iPhone and Android apps. A routine shows its name when the list of routines has it; a system wake shows what woke the agent
 * (`label`, else the wake kind in plain words), and nothing for an entry no run belongs to.
 */
export function startedByLine(initiator: AuditEntry["initiator"], routineName?: string): string {
  switch (initiator.type) {
    case "owner_message":
      return t("audit.startedByYou");
    case "channel": {
      const platform = channelPlatformName(initiator.channel);
      if (initiator.speaker === "owner") return t("audit.startedByYouOn", { platform });
      if (initiator.speaker === "member") return t("audit.startedByMemberOn", { platform });
      return t("audit.startedByStrangerOn", { platform });
    }
    case "routine":
      return routineName === undefined ? t("audit.startedByRoutine") : t("audit.startedByRoutineNamed", { name: routineName });
    case "parent_run":
      return t("audit.startedByTask");
    case "system": {
      const what = initiator.label ?? (initiator.wakeKind === "system" ? undefined : initiator.wakeKind.replaceAll("_", " "));
      return what === undefined ? t("audit.startedBySystem") : t("audit.startedBySystemFor", { what });
    }
  }
}

/** Hand the CSV text to the browser as a file download. */
export function downloadCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
