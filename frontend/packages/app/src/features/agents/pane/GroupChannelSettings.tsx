import type { Conversation, GroupDelegableCategory, GroupSettings } from "@agent-desktop/client";
import { Label, ListRow, Section, Switch, toast } from "@agent-desktop/ui";
import { Check } from "lucide-react";
import { channelPlatformName } from "../../../components/channel/platforms";
import { categoryLabel } from "../../../components/request/decision";
import { useGroupSettings, useUpdateGroupSettings } from "../../../data/group";
import { t } from "../../../lib/i18n";

const DELEGABLE: readonly GroupDelegableCategory[] = ["spending", "speaking", "public", "committing", "sharing"];

/** "2 Nov, 14:05" */
function whenText(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** What the agent has read of the channel's past: one quiet line, or nothing before the first read starts. */
export function backfillLine(settings: GroupSettings, agent: string): string | undefined {
  const backfill = settings.backfill;
  if (!backfill) return undefined;
  if (backfill.status === "running") return t("group.backfill.running");
  if (backfill.status === "unavailable") return t("group.backfill.unavailable", { platform: channelPlatformName(settings.platform), agent });
  if (backfill.status === "failed") return t("group.backfill.failed");
  return t("group.backfill.done", { count: backfill.count ?? 0, when: whenText(backfill.at) });
}

/**
 * A platform group's settings, in the group's panel (owner only): whether the agent reads the channel, what it read
 * from before it joined, the switch for speaking up unprompted, and the kinds of decision a teammate's ask may use
 * without asking the owner. Each change saves at once and goes back if the save fails.
 */
export function GroupChannelSettings({ conversation, agentName }: { conversation: Conversation; agentName: string }) {
  const isPlatformGroup = conversation.kind === "room" && conversation.channel !== undefined;
  const { data: settings } = useGroupSettings(conversation.id, isPlatformGroup);
  const update = useUpdateGroupSettings(conversation.id);
  if (!settings) return null;

  const save = (input: Parameters<typeof update.mutate>[0]) => update.mutate(input, { onError: () => toast.error(t("group.saveFailed")) });
  const toggle = (category: GroupDelegableCategory) =>
    save({ delegated: settings.delegated.includes(category) ? settings.delegated.filter((entry) => entry !== category) : [...settings.delegated, category] });
  const history = backfillLine(settings, agentName);

  return (
    <Section title={t("group.title")} className="mt-6 gap-1 px-2" contentClassName="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-fg">{settings.observes ? t("group.observes", { agent: agentName }) : t("group.notObserved", { agent: agentName })}</p>
        {history ? <p className="text-sm text-fg-muted">{history}</p> : null}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="group-speak" className="text-sm font-medium text-fg">
            {t("group.speak")}
          </Label>
          <Switch id="group-speak" checked={settings.speak} onCheckedChange={(speak) => save({ speak })} />
        </div>
        <p className="text-sm text-fg-muted">{t("group.speakHelp", { agent: agentName })}</p>
      </div>
      <div className="flex flex-col gap-1">
        <h3 id="group-delegated" className="text-sm font-medium text-fg">
          {t("group.delegated")}
        </h3>
        <ul aria-labelledby="group-delegated" className="flex flex-col">
          {DELEGABLE.map((category) => {
            const on = settings.delegated.includes(category);
            return (
              <li key={category}>
                <ListRow
                  role="checkbox"
                  dense
                  selected={on}
                  title={categoryLabel(category)}
                  trailing={on ? <Check className="size-4 text-fg" aria-hidden="true" /> : <span className="size-4" />}
                  onClick={() => toggle(category)}
                />
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-fg-muted">{t("group.delegatedHelp")}</p>
      </div>
    </Section>
  );
}
