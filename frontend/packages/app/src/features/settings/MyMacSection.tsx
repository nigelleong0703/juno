import { Button, toast } from "@agent-desktop/ui";
import { usePlatform } from "../../data/ClientProvider";
import { macChoice, useLinkState, usePairMyMac, useMyMac, useStopMyMac, useUnpairMyMac } from "../../data/my-mac";
import { t } from "../../lib/i18n";
import { MyMacApps } from "./MyMacApps";
import { MyMacDesktopRows } from "./MyMacDesktopRows";
import { Group, Row } from "./SettingsGroup";

/**
 * My Mac: this Mac as a computer for agents. On the desktop app it pairs (the server issues a token, the shell keeps it in the
 * Keychain and holds the link) and shows what is running with a Stop; on the web it only shows the state and can disconnect.
 */
export function MyMacSection() {
  const platform = usePlatform();
  const mac = platform.myMac;
  const server = useMyMac();
  const local = useLinkState(mac);
  const pair = usePairMyMac();
  const unpair = useUnpairMyMac();
  const stop = useStopMyMac();
  const failed = () => toast(t("myMac.failed"));
  const connect = () =>
    pair.mutate(local?.deviceName, {
      onSuccess: (pairing) => void mac?.connect(pairing).catch(failed),
      onError: failed,
    });
  const disconnect = () =>
    unpair.mutate(undefined, {
      onSuccess: () => void mac?.disconnect().catch(failed),
      onError: failed,
    });

  const choice = macChoice(server.data);
  // The shell's link is the truth for "this Mac" while it holds a pairing; the server's view covers a Mac paired elsewhere.
  const connected = mac ? local?.paired === true && choice !== "unpaired" : choice !== "unpaired";
  const label = !connected
    ? local?.status === "unauthorized" ? t("myMac.state.reconnect") : t("myMac.state.unpaired")
    : local?.status === "connecting" ? t("myMac.state.connecting")
    : choice === "online" ? t("myMac.state.online") : t("myMac.state.offline");
  const busy = pair.isPending || unpair.isPending;
  const stopped = server.data?.stopped !== undefined;

  return (
    <>
    <Group description={mac ? t("myMac.hint") : t("myMac.webHint")}>
      <Row label={mac ? t("myMac.status") : server.data?.name ?? t("myMac.status")} description={label}>
        {connected ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={disconnect}>
            {t("myMac.disconnect")}
          </Button>
        ) : mac ? (
          <Button variant="primary" size="sm" disabled={busy || server.isPending} onClick={connect}>
            {t("myMac.connect")}
          </Button>
        ) : null}
      </Row>
      {mac && connected && local ? (
        <>
          <MyMacDesktopRows mac={mac} />
          <Row label={t("myMac.folder")}>
            <span className="font-mono text-xs text-fg-muted">{local.folder}</span>
          </Row>
          <Row
            label={t("myMac.activity")}
            description={local.stopped || stopped ? t("myMac.stopped") : local.running > 0 ? t("myMac.running", { command: local.command ?? "" }) : t("myMac.idle")}
          >
            {local.stopped ? (
              <Button variant="secondary" size="sm" onClick={() => mac.setStopped(false)}>
                {t("myMac.resume")}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" disabled={local.running === 0} onClick={() => mac.setStopped(true)}>
                {t("myMac.stop")}
              </Button>
            )}
          </Row>
        </>
      ) : null}
      {!mac && connected ? (
        // Any client can Stop the Mac; only the Mac itself can resume, so the web has no Resume.
        <Row label={t("myMac.activity")} description={stopped ? t("myMac.stopped") : t("myMac.stopHint")}>
          <Button variant="secondary" size="sm" disabled={stopped || stop.isPending} onClick={() => stop.mutate(undefined, { onError: failed })}>
            {t("myMac.stop")}
          </Button>
        </Row>
      ) : null}
    </Group>
    <MyMacApps />
    </>
  );
}
