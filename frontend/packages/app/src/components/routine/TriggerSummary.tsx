import type { Routine } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { CalendarClock, GitBranch, Mail, MessageSquare, Webhook, Hash, type LucideIcon } from "lucide-react";
import { formatDuration } from "../../lib/format";
import { t } from "../../lib/i18n";

export interface TriggerSummaryProps {
  routine: Routine;
  className?: string;
}

function deliveryText(routine: Routine): string {
  const { delivery } = routine;
  if (delivery.channel === "chat") return t("routines.delivery.chat");
  if (delivery.channel === "slack") {
    return t("routines.delivery.slack", { target: delivery.target ?? "#channel" });
  }
  return t("routines.delivery.email", { target: delivery.target ?? "you" });
}

function triggerIcon(trigger: Routine["trigger"]): LucideIcon {
  if (trigger.kind === "schedule") return CalendarClock;
  if (trigger.kind !== "event") return Webhook;
  if (trigger.source === "github") return GitBranch;
  if (trigger.source === "slack") return Hash;
  if (trigger.source === "email") return Mail;
  return Webhook;
}

function triggerPrimary(trigger: Routine["trigger"]): string {
  if (trigger.kind === "schedule") return t("routines.trigger.schedule", { human: trigger.human });
  if (trigger.kind === "event") return t("routines.trigger.event", { filter: trigger.filter });
  return t("routines.trigger.webhook");
}

/** One-line (or two-line) human summary of a routine's trigger + delivery. */
export function TriggerSummary({ routine, className }: TriggerSummaryProps) {
  const { trigger } = routine;
  const Icon = triggerIcon(trigger);
  const primary = triggerPrimary(trigger);

  return (
    <div className={cn("flex items-center gap-2 text-sm", className)}>
      <Icon className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="truncate text-fg-muted">{primary}</span>
      <span className="text-fg-subtle">→</span>
      <span className="inline-flex items-center gap-1 truncate text-fg-muted">
        <MessageSquare className="size-3.5 shrink-0 text-fg-subtle" />
        {deliveryText(routine)}
      </span>
      {routine.runs[0]?.durationMs ? (
        <span className="ml-auto shrink-0 text-xs text-fg-subtle">
          {formatDuration(routine.runs[0].durationMs)}
        </span>
      ) : null}
    </div>
  );
}
