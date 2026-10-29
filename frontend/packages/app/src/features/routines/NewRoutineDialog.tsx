import type { Delivery, RoutineTrigger } from "@agent-desktop/client";
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@agent-desktop/ui";
import { useState } from "react";
import { useCreateRoutine } from "../../data/routines";
import { useAgents } from "../../data/queries";
import { t } from "../../lib/i18n";
import { SCHEDULE_PRESETS, TIMEZONES, localTimeZone, presetForCron } from "./cron";

export function NewRoutineDialog({
  open,
  onOpenChange,
  defaultAgentId = "",
  defaultCron = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agent preselected in the picker (opened from an agent's page). */
  defaultAgentId?: string;
  /** Schedule preselected (a clicked calendar slot): a preset when it is one, else Custom. */
  defaultCron?: string;
}) {
  const initialPreset = defaultCron ? (presetForCron(defaultCron)?.id ?? "custom") : "weekdays-9";
  const create = useCreateRoutine();
  const { data: agents } = useAgents();

  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [presetId, setPresetId] = useState(initialPreset);
  const [cron, setCron] = useState(defaultCron);
  const [tz, setTz] = useState(localTimeZone());

  const reset = () => {
    setName("");
    setAgentId(defaultAgentId);
    setPresetId(initialPreset);
    setCron(defaultCron);
    setTz(localTimeZone());
  };

  const submit = () => {
    if (!name.trim() || !agentId) return;
    const preset = SCHEDULE_PRESETS.find((entry) => entry.id === presetId);
    const expression = preset?.cron ? preset.cron : cron.trim();
    if (!expression) {
      toast.error("Enter a cron expression");
      return;
    }
    // Only schedule triggers fire and only chat delivery lands today; event / webhook triggers and
    // Slack / email delivery stay hidden until the backend runs them (P-04).
    const trigger: RoutineTrigger = {
      kind: "schedule",
      cron: expression,
      human: `${preset?.cron ? preset.human : expression} (${tz})`,
      tz,
    };
    const delivery: Delivery = { channel: "chat" };
    create.mutate(
      { name: name.trim(), agentId, trigger, delivery },
      {
        onSuccess: () => {
          toast("Routine created", { description: name.trim() });
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("routines.new")}</DialogTitle>
          <DialogDescription>An agent runs it on a schedule and posts the result in chat.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm text-fg-muted">Name</span>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="e.g. Morning inbox triage"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm text-fg-muted">Agent</span>
            <Combobox
              className="h-9 w-full text-sm"
              value={agentId}
              onValueChange={setAgentId}
              placeholder="Pick an agent"
              searchPlaceholder="Find an agent…"
              options={(agents ?? []).map((agent) => ({ value: agent.id, label: agent.name }))}
            />
          </label>

          <div className="space-y-3">
            <span className="block text-sm text-fg-muted">Schedule</span>
            <Select
              value={presetId}
              onValueChange={(value) => {
                setPresetId(value);
                const preset = SCHEDULE_PRESETS.find((entry) => entry.id === value);
                if (preset?.cron) setCron(preset.cron);
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
            <Combobox
              className="h-9 w-full text-sm"
              value={tz}
              onValueChange={setTz}
              placeholder="Time zone"
              searchPlaceholder="Find a time zone…"
              options={TIMEZONES.map((zone) => ({ value: zone, label: zone }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!name.trim() || !agentId || create.isPending}
            onClick={submit}
          >
            Create routine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
