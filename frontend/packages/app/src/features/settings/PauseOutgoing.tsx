import { Switch } from "@agent-desktop/ui";
import { channelPlatformName } from "../../components/channel/platforms";
import { useDeliveryStatus, useSetOutgoingPaused } from "../../data/delivery";
import { t } from "../../lib/i18n";
import { Group, Row } from "./SettingsGroup";

/** Failing connected apps named before "and N more". */
const FAILING_SHOWN = 3;

const PHONE = "phone";

/** One line per failing app or phone service, once each. */
function failingLines(platforms: readonly string[]): string[] {
  const keys = [...new Set(platforms.map((platform) => (platform === "ios" || platform === "android" ? PHONE : platform)))];
  const lines = keys.map((key) => (key === PHONE ? t("delivery.failingPhone") : t("delivery.failing", { name: channelPlatformName(key) })));
  const more = lines.length - FAILING_SHOWN;
  return more > 0 ? [...lines.slice(0, FAILING_SHOWN), t("delivery.failingMore", { count: more })] : lines;
}

/**
 * "Pause outgoing messages" at the top of Settings › What's worth interrupting me for (the notification settings): one switch row for
 * the owner's pause, shown on and locked when the service has paused sending, and one line under it for each app that is not
 * delivering right now.
 */
export function PauseOutgoing() {
  const { data } = useDeliveryStatus();
  const setPaused = useSetOutgoingPaused();
  if (!data) return null;
  const service = data.frozen.operator;
  const lines = failingLines(data.failing.map((entry) => entry.platform));
  return (
    <Group>
      <Row label={t("delivery.pause.title")} description={service ? t("delivery.pause.service") : t("delivery.pause.hint")}>
        <Switch
          aria-label={t("delivery.pause.title")}
          checked={service || data.frozen.owner}
          disabled={service || setPaused.isPending}
          onCheckedChange={(value) => setPaused.mutate(value)}
        />
      </Row>
      {lines.map((line) => (
        <p key={line} className="px-2.5 pb-1.5 text-xs text-warning">
          {line}
        </p>
      ))}
    </Group>
  );
}
