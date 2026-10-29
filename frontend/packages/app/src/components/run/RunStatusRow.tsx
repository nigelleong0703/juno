import type { Run } from "@agent-desktop/client";
import { CircleAlert, CircleStop } from "lucide-react";
import { useSendMessage } from "../../data/mutations";
import { useItems } from "../../data/queries";
import { t } from "../../lib/i18n";

/** A task that failed or was stopped: one quiet line, like iMessage's "Not Delivered". */
export function RunStatusRow({ run, onOpen }: { run: Run; onOpen?: (runId: string) => void }) {
  const failed = run.status === "failed";
  const { data: items } = useItems(run.conversationId);
  const send = useSendMessage(run.conversationId);
  // The message that started the run: the owner's message right before it.
  const trigger = items?.findLast(
    (item) => item.type === "user_message" && Date.parse(item.at) <= Date.parse(run.startedAt) + 2000,
  );
  const retry = () => {
    if (trigger?.type === "user_message" && trigger.text) {
      send.mutate({ text: trigger.text, attachments: trigger.attachments, mentions: trigger.mentions });
    } else onOpen?.(run.id);
  };
  const Icon = failed ? CircleAlert : CircleStop;
  return (
    <div
      data-slot={failed ? "run-failed" : "run-stopped"}
      className={`flex items-center gap-1 pl-1 text-xs ${failed ? "text-danger" : "text-fg-muted"}`}
    >
      <Icon aria-hidden className="size-3" />
      {failed ? (
        <>
          <span>{t("tasks.failed")}</span>
          <span aria-hidden>·</span>
          <button type="button" onClick={retry} className="font-semibold focus-ring">
            {t("run.retry")}
          </button>
        </>
      ) : (
        <button type="button" onClick={() => onOpen?.(run.id)} className="focus-ring">
          {t("tasks.stopped")}
        </button>
      )}
    </div>
  );
}
