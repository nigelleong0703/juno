import { ListRow } from "@agent-desktop/ui";
import { ChevronRight } from "lucide-react";
import { useNavigate } from "react-router";
import { BrandIcon } from "../../components/BrandIcon";
import { macChoice, useMyMac } from "../../data/my-mac";
import { t } from "../../lib/i18n";

/** Whether a search leaves the Mac row visible. */
export const macRowMatches = (query: string): boolean => `${t("apps.mac.title")} ${t("apps.mac.blurb")} outlook exchange icloud`.toLowerCase().includes(query.trim().toLowerCase());

/** "Your Mac" is not an app in the directory but a capability of the paired Mac: the row shows whether the link is up and opens where it is set up. */
export function MacRow() {
  const navigate = useNavigate();
  const status = useMyMac().data;
  const state = macChoice(status);
  return (
    <ListRow
      onClick={() => navigate("/settings/mac")}
      className="py-2.5"
      leading={<BrandIcon symbol="laptop" className="size-11 rounded-xl" />}
      title={t("apps.mac.title")}
      description={t("apps.mac.blurb")}
      trailing={
        <span className="flex items-center gap-2">
          {state === "unpaired" ? <span className="text-xs text-fg-subtle">{t("apps.mac.setUp")}</span> : null}
          {state === "offline" ? <span className="text-xs text-fg-subtle">{t("apps.mac.offline")}</span> : null}
          {state === "online" ? <span className="text-xs text-fg-subtle">{status?.stopped ? t("apps.mac.stopped") : t("apps.state.connected")}</span> : null}
          <ChevronRight className="size-4 text-fg-subtle" aria-hidden />
        </span>
      }
    />
  );
}
