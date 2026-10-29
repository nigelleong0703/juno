import { Button, toast } from "@agent-desktop/ui";
import { Check, Laptop } from "lucide-react";
import { usePlatform } from "../../data/ClientProvider";
import { useUpdateAgent } from "../../data/mutations";
import { macChoice, useLinkState, useMyMac, usePairMyMac } from "../../data/my-mac";
import { useAgent } from "../../data/queries";
import { t } from "../../lib/i18n";

/**
 * The `mac` option of a Connect card: the owner's Mac as Mail, Calendar and Reminders. One button for what is missing:
 * pair the Mac (desktop app only), then allow this agent on it; offline has nothing to tap. The server closes the card.
 */
export function MacConnect({ agentId, agentName, resolved, disabled }: { agentId: string; agentName: string; resolved: boolean; disabled: boolean }) {
  const mac = usePlatform().myMac;
  const status = useMyMac().data;
  const choice = macChoice(status);
  const stopped = status?.stopped !== undefined;
  const agent = useAgent(agentId).data;
  const update = useUpdateAgent();
  const local = useLinkState(mac);
  const pair = usePairMyMac();
  const failed = () => toast(t("myMac.failed"));
  const connect = () => pair.mutate(local?.deviceName, { onSuccess: (pairing) => void mac?.connect(pairing).catch(failed), onError: failed });

  let action = null;
  let note = t("connect.macPermission");
  if (resolved || (choice === "online" && !stopped && agent?.macAccess === true)) {
    action = (
      <span className="flex shrink-0 items-center gap-1 text-xs text-fg-muted">
        <Check aria-hidden className="size-3.5" />
        {t("connect.connected")}
      </span>
    );
  } else if (choice === "unpaired") {
    if (mac) action = <Button variant="primary" size="xs" disabled={disabled || pair.isPending} onClick={connect}>{t("connect.macPair")}</Button>;
    else note = t("connect.macPairOnMac");
  } else if (agent?.macAccess !== true) {
    action = <Button variant="primary" size="xs" disabled={disabled || update.isPending || !agent} onClick={() => update.mutate({ id: agentId, patch: { macAccess: true } })}>{t("connect.macAllow", { agent: agentName })}</Button>;
  } else {
    note = stopped ? t("myMac.stopped") : t("connect.macOffline");
  }
  return (
    <div className="flex items-center gap-3 py-1.5">
      <Laptop aria-hidden className="size-8 shrink-0 rounded-full bg-muted p-1.5 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">{t("connect.macName")}</div>
        <div className="text-xs text-fg-muted">{note}</div>
      </div>
      {action}
    </div>
  );
}
