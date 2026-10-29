import type { Routine, RoutineTrigger, RoutineWebhookSecret } from "@agent-desktop/client";
import {
  Button,
  Combobox,
  CopyField,
  Input,
  RelativeTime,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  Switch,
  cn,
  toast,
} from "@agent-desktop/ui";
import { Clock, GitBranch, Hash, Mail, MessageSquare, Play, Webhook } from "lucide-react";
import { useState } from "react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { RoutineSetupNote } from "../../components/routine";
import { useToggleRoutine } from "../../data/mutations";
import { useRotateWebhookSecret, useUpdateRoutine } from "../../data/routines";
import { useAgents } from "../../data/queries";
import { formatDuration } from "../../lib/format";
import { t } from "../../lib/i18n";
import { routineRuns, routineStatusMeta } from "../../lib/status";
import { SCHEDULE_PRESETS, TIMEZONES, describeCron, localTimeZone, presetForCron } from "./cron";

/**
 * Trigger + delivery + history for one routine (§4.6). Shared by the detail sheet opened from a
 * row and the standalone `/routines/:id` page, so the two never drift.
 */
export function RoutineEditor({ routine }: { routine: Routine }) {
  const update = useUpdateRoutine();
  const toggle = useToggleRoutine();
  const { data: agents } = useAgents();
  const agent = agents?.find((entry) => entry.id === routine.agentId);

  // Only schedule routines are editable: event / webhook triggers and Slack / email delivery don't
  // fire from here, so routines that already have them are shown read-only and saved untouched (P-04).
  const isSchedule = routine.trigger.kind === "schedule";
  const initialCron = routine.trigger.kind === "schedule" ? (routine.trigger.cron ?? "") : "";
  const [presetId, setPresetId] = useState<string>(
    presetForCron(initialCron)?.id ?? (initialCron ? "custom" : "weekdays-9"),
  );
  const [cron, setCron] = useState(initialCron);
  const [tz, setTz] = useState(
    routine.trigger.kind === "schedule" ? routine.trigger.tz : localTimeZone(),
  );

  const preset = SCHEDULE_PRESETS.find((entry) => entry.id === presetId);
  const cronPreview = describeCron(preset?.cron ? preset.cron : cron);

  const buildTrigger = (): RoutineTrigger | undefined => {
    const expression = preset?.cron ? preset.cron : cron.trim();
    if (!expression) return undefined;
    const words = preset?.cron ? preset.human : (describeCron(expression) ?? expression);
    return { kind: "schedule", cron: expression, human: `${words} (${tz})`, tz };
  };

  const save = () => {
    if (!isSchedule) return;
    const trigger = buildTrigger();
    if (!trigger) {
      toast.error("Finish the trigger first", { description: "Enter a cron expression." });
      return;
    }
    update.mutate(
      { id: routine.id, patch: { trigger } },
      { onSuccess: () => toast("Routine saved", { description: routine.name }) },
    );
  };

  const meta = routineStatusMeta[routine.status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-4 pb-6">
        {/* Agent + state */}
        <div className="flex items-center gap-3">
          {agent && <AgentAvatar agentId={agent.id} avatar={agent.avatar} status={agent.status} size="md" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-fg">{agent?.name ?? "Agent"}</div>
            <div className="text-xs text-fg-subtle">{t("routines.runsAs")}</div>
          </div>
          <StatusPill size="sm" tone={meta.tone} label={t(meta.label)} />
          <Switch
            checked={routineRuns(routine)}
            disabled={routine.status === "needs_setup"}
            onCheckedChange={(checked) => toggle.mutate({ id: routine.id, enabled: checked })}
            aria-label={t("routines.enabled")}
          />
        </div>

        <RoutineSetupNote routine={routine} />

        {routine.instructions && (
          <p className="text-sm text-fg-muted">{routine.instructions}</p>
        )}

        {/* Trigger */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-fg">Trigger</h3>

          {isSchedule && (
            <div className="space-y-3">
              <Select
                value={presetId}
                onValueChange={(value) => {
                  setPresetId(value);
                  const next = SCHEDULE_PRESETS.find((entry) => entry.id === value);
                  if (next?.cron) setCron(next.cron);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_PRESETS.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {presetId === "custom" && (
                <Input
                  value={cron}
                  onChange={(event) => setCron(event.currentTarget.value)}
                  placeholder="0 9 * * 1-5"
                  className="font-mono"
                  aria-label="Cron expression"
                />
              )}

              <div className="flex items-center gap-2">
                <Combobox
                  className="h-9 flex-1 text-sm"
                  value={tz}
                  onValueChange={setTz}
                  placeholder="Time zone"
                  searchPlaceholder="Find a time zone…"
                  options={TIMEZONES.map((zone) => ({ value: zone, label: zone }))}
                />
              </div>

              <p className="text-xs text-fg-subtle">
                {cronPreview ? `${cronPreview} · ${tz}` : "Enter a cron expression"}
              </p>
            </div>
          )}

          {!isSchedule && (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm text-fg-muted">
                {triggerIcon(routine.trigger.kind)}
                {triggerText(routine)}
              </p>
              {routine.trigger.kind === "webhook" && (
                <>
                  <CopyField label="Endpoint" value={routine.trigger.url} />
                  <WebhookSecret routineId={routine.id} secretMasked={routine.trigger.secretMasked} />
                </>
              )}
              <p className="text-xs text-fg-subtle">This trigger can't be changed here.</p>
            </div>
          )}
        </section>

        {/* Delivery: results always land in chat; an older Slack / email target is shown, not editable. */}
        {routine.delivery.channel !== "chat" && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium text-fg">Deliver results</h3>
            <p className="text-sm text-fg-muted">
              {routine.delivery.channel === "slack" ? "Slack" : "Email"}
              {routine.delivery.target ? `: ${routine.delivery.target}` : ""}
            </p>
          </section>
        )}

        {/* History */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-fg">{t("routines.history")}</h3>
          {routine.runs.length === 0 ? (
            <p className="text-sm text-fg-subtle">{t("collection.emptyHint")}</p>
          ) : (
            <ul>
              {routine.runs.map((run) => (
                <li key={run.id} className="flex items-center gap-3 py-1.5">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      run.status === "failed"
                        ? "bg-danger"
                        : run.status === "running"
                          ? "bg-accent"
                          : run.status === "skipped"
                            ? "bg-fg-subtle"
                            : "bg-success",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{run.summary}</span>
                  {run.durationMs !== undefined && (
                    <span className="shrink-0 text-xs text-fg-subtle">
                      {formatDuration(run.durationMs)}
                    </span>
                  )}
                  <RelativeTime date={run.startedAt} className="shrink-0 text-xs text-fg-subtle" />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Quick facts */}
        <section className="space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">{t("routines.next")}</span>
            <span className="text-fg">
              {routine.nextRunAt ? <RelativeTime date={routine.nextRunAt} /> : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">{t("routines.last")}</span>
            <span className="text-fg">
              {routine.lastRunAt ? <RelativeTime date={routine.lastRunAt} /> : "—"}
            </span>
          </div>
        </section>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="ghost" size="sm" disabled={routine.status === "needs_setup"} onClick={() => toggle.mutate({ id: routine.id, enabled: !routine.enabled })}>
          <Play className="size-3.5" />
          {routineRuns(routine) ? t("routines.disabled") : t("routines.enabled")}
        </Button>
        <Button variant="primary" size="sm" disabled={update.isPending || !isSchedule} onClick={save}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The webhook secret: generated or rotated here, and shown in full only in the answer to that request. Afterwards the
 * page only knows the masked form, so it can never be read back.
 */
function WebhookSecret({ routineId, secretMasked }: { routineId: string; secretMasked: string }) {
  const rotate = useRotateWebhookSecret();
  const [minted, setMinted] = useState<RoutineWebhookSecret | undefined>(undefined);
  return (
    <div className="space-y-2">
      {minted ? (
        <CopyField label="Secret (shown once)" value={minted.secret} />
      ) : secretMasked ? (
        <p className="font-mono text-xs text-fg-subtle">{secretMasked}</p>
      ) : (
        <p className="text-xs text-fg-subtle">no secret yet</p>
      )}
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" disabled={rotate.isPending} onClick={() => rotate.mutate(routineId, { onSuccess: setMinted })}>
          Generate / Rotate secret
        </Button>
        <span className="text-xs text-fg-subtle">Rotating makes the old secret stop working at once.</span>
      </div>
    </div>
  );
}

/** The icon shown next to a routine's trigger kind in lists. */
export function triggerIcon(kind: RoutineTrigger["kind"]) {
  if (kind === "schedule") return <Clock className="size-3.5" />;
  if (kind === "webhook") return <Webhook className="size-3.5" />;
  return <GitBranch className="size-3.5" />;
}

/** Human words for a routine's trigger, preferring the stored `human` when present. */
export function triggerText(routine: Routine): string {
  const { trigger } = routine;
  if (trigger.kind === "schedule") {
    return trigger.human || describeCron(trigger.cron ?? "") || "Scheduled";
  }
  if (trigger.kind === "event") {
    const source =
      trigger.source === "github"
        ? "GitHub"
        : trigger.source === "slack"
          ? "Slack"
          : trigger.source === "email"
            ? "Email"
            : "MCP";
    return `${source}: ${trigger.filter}`;
  }
  return "Webhook";
}

export const DELIVERY_ICON = {
  chat: MessageSquare,
  slack: Hash,
  email: Mail,
} as const;
