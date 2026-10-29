import type { AgentCalendarItem } from "@agent-desktop/client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, toast } from "@agent-desktop/ui";
import { CheckSquare, UserRound, Video, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useCancelCalendarItem, useUpdateCalendarItem } from "../../data/calendar";
import { t } from "../../lib/i18n";

export const KIND_ICON: Record<AgentCalendarItem["kind"], LucideIcon> = {
  follow_up: UserRound,
  meeting: Video,
  task: CheckSquare,
};

export function kindLabel(kind: AgentCalendarItem["kind"]): string {
  return kind === "follow_up" ? t("automations.cal.item.followUp") : kind === "meeting" ? t("automations.cal.item.meeting") : t("automations.cal.item.task");
}

export function statusLabel(status: AgentCalendarItem["status"]): string {
  return status === "done" ? t("automations.cal.done") : status === "missed" ? t("automations.cal.missed") : t("automations.cal.item.scheduled");
}

/** `YYYY-MM-DDTHH:mm` in local time, the value a datetime-local input wants. */
function localInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-fg">{children}</dd>
    </div>
  );
}

/** One item from an agent's own calendar: what it is, when, with whom, and how it went; the owner may move or cancel it. */
export function CalendarItemDialog({ item, onClose }: { item: AgentCalendarItem; onClose: () => void }) {
  const update = useUpdateCalendarItem();
  const cancel = useCancelCalendarItem();
  const [when, setWhen] = useState(() => localInputValue(item.at));
  const [confirming, setConfirming] = useState(false);
  const open = item.status === "scheduled";
  const Icon = KIND_ICON[item.kind];
  const fail = () => toast.error(t("automations.cal.item.failed"));

  const reschedule = () => {
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) return;
    update.mutate({ id: item.id, input: { at: at.toISOString() } }, { onSuccess: onClose, onError: fail });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-4 shrink-0 text-fg-muted" />
            <span className="min-w-0 truncate">{item.title}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">{kindLabel(item.kind)}</DialogDescription>
        </DialogHeader>
        <dl className="space-y-2">
          <Row label={kindLabel(item.kind)}>{statusLabel(item.status)}</Row>
          <Row label={t("automations.cal.item.when")}>
            {new Date(item.at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </Row>
          {item.withWhom ? <Row label={t("automations.cal.item.withWhom")}>{item.withWhom.name}</Row> : null}
          {item.instructions ? <Row label={t("automations.cal.item.instructions")}>{item.instructions}</Row> : null}
          {item.result ? <Row label={t("automations.cal.item.status")}>{item.result}</Row> : null}
        </dl>
        {open ? (
          <div className="flex items-center gap-2">
            <Input type="datetime-local" aria-label={t("automations.cal.item.reschedule")} value={when} onChange={(event) => setWhen(event.target.value)} />
            <Button variant="outline" disabled={update.isPending || when === localInputValue(item.at)} onClick={reschedule}>
              {t("automations.cal.item.reschedule")}
            </Button>
          </div>
        ) : null}
        {open ? (
          <DialogFooter>
            {confirming ? (
              <>
                <span className="mr-auto self-center text-sm text-fg-muted">{t("automations.cal.item.cancelConfirm")}</span>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  {t("automations.cal.item.keep")}
                </Button>
                <Button variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate(item.id, { onSuccess: onClose, onError: fail })}>
                  {t("automations.cal.item.cancelYes")}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setConfirming(true)}>
                {t("automations.cal.item.cancel")}
              </Button>
            )}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
