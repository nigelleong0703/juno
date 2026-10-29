import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FormField,
  ListRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@agent-desktop/ui";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { CHANNEL_PLATFORMS, ChannelIcon } from "../../../components/channel/platforms";
import { useApp } from "../../../data/apps";
import { useAgents } from "../../../data/queries";
import { t } from "../../../lib/i18n";
import { QuickConnect, type ChatKind } from "./flows";

const KINDS: readonly ChatKind[] = ["telegram", "slack", "discord", "feishu"];

export interface ChatConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The platform; omitted, the dialog starts by asking which one (an agent's own bot, from its settings). */
  kind?: ChatKind;
  /** The agent the bot is for; omitted, the dialog asks (Telegram and Feishu always need one). */
  agentId?: string;
}

/**
 * Add a chat app: the shared Slack app or Discord bot into a workspace, a Telegram bot or Feishu app made for an agent. Nobody
 * pastes a token or secret. A Telegram bot or Feishu app belongs to one agent, so the dialog asks which when it was opened from
 * the app rather than from an agent.
 */
export function ChatConnectDialog({ open, onOpenChange, kind: initialKind, agentId: fixedAgent }: ChatConnectDialogProps) {
  const [picked, setPicked] = useState<ChatKind | null>(initialKind ?? null);
  const kind = initialKind ?? picked;
  const [chosenAgent, setChosenAgent] = useState<string | undefined>(undefined);
  const { data: agents } = useAgents();
  const agentId = fixedAgent ?? chosenAgent ?? agents?.[0]?.id;
  const { data: app } = useApp(kind ?? undefined);
  const startCount = app?.installations.length ?? 0;
  const needsAgent = kind === "telegram" || kind === "feishu";

  const close = (next: boolean) => {
    if (!next) {
      setPicked(null);
    }
    onOpenChange(next);
  };

  const name = kind ? (CHANNEL_PLATFORMS[kind]?.name ?? kind) : "";
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{kind ? t("apps.connectTo", { name }) : t("apps.pickPlatform")}</DialogTitle>
          <DialogDescription>{kind ? t("apps.connectChatHint") : t("apps.pickPlatformHint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {kind === null ? (
            <ul className="space-y-1">
              {KINDS.map((entry) => (
                <li key={entry}>
                  <ListRow
                    onClick={() => setPicked(entry)}
                    leading={<ChannelIcon kind={entry} />}
                    title={CHANNEL_PLATFORMS[entry]?.name ?? entry}
                    trailing={<ChevronRight className="size-4 text-fg-subtle" aria-hidden />}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <>
              {needsAgent && !fixedAgent ? (
                <FormField label={t("apps.forAgent")}>
                  <Select value={agentId ?? ""} onValueChange={setChosenAgent}>
                    <SelectTrigger aria-label={t("apps.forAgent")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(agents ?? []).map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              ) : null}
              <QuickConnect kind={kind} agentId={fixedAgent ?? (needsAgent ? agentId : undefined)} startCount={startCount} />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
