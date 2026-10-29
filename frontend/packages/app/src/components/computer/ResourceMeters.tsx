import type { Computer } from "@agent-desktop/client";
import { Meter, cn } from "@agent-desktop/ui";
import { formatBytes, formatCount } from "../../lib/format";
import { t } from "../../lib/i18n";

export interface ResourceMetersProps {
  computer: Computer;
  /** One compact row of three meters for the strip under the screen. */
  compact?: boolean;
  className?: string;
}

/**
 * Neutral fill (the ui `default` tone draws `bg-foreground` on a `bg-muted` track) unless the
 * resource is genuinely close to full, where it turns warning. Owner feedback: no coloured bars
 * for ordinary load, and never red for capacity.
 */
function toneFor(fraction: number): "default" | "warning" {
  return fraction >= 0.9 ? "warning" : "default";
}

/** CPU / memory / disk for one computer, from `computer.resources`. */
export function ResourceMeters({ computer, compact, className }: ResourceMetersProps) {
  const { cpu, memory, disk } = computer.resources;
  const memoryMb = memory.total;
  const memFraction = memoryMb > 0 ? memory.used / memoryMb : 0;

  if (compact) {
    return (
      <div className={cn("grid grid-cols-3 gap-3", className)}>
        <Meter
          value={cpu.used}
          max={cpu.total}
          tone={toneFor(cpu.used / cpu.total)}
          label={t("computer.cpu")}
          valueLabel={`${formatCount(cpu.used)}%`}
        />
        <Meter
          value={memory.used}
          max={memoryMb}
          tone={toneFor(memFraction)}
          label={t("computer.memory")}
          valueLabel={formatBytes(memory.used * 1024 * 1024)}
        />
        <Meter
          value={disk.used}
          max={disk.total}
          tone={toneFor(disk.used / disk.total)}
          label={t("computer.disk")}
          valueLabel={`${disk.used}/${disk.total} GB`}
        />
      </div>
    );
  }

  return (
    <div className={cn("space-y-2.5", className)}>
      <Meter
        value={cpu.used}
        max={cpu.total}
        tone={toneFor(cpu.used / cpu.total)}
        label={`${t("computer.cpu")} · ${cpu.cores} vCPU`}
        valueLabel={`${formatCount(cpu.used)}%`}
      />
      <Meter
        value={memory.used}
        max={memoryMb}
        tone={toneFor(memFraction)}
        label={t("computer.memory")}
        valueLabel={`${formatBytes(memory.used * 1024 * 1024)} / ${memory.total / 1024} GB`}
      />
      <Meter
        value={disk.used}
        max={disk.total}
        tone={toneFor(disk.used / disk.total)}
        label={t("computer.disk")}
        valueLabel={`${disk.used} / ${disk.total} GB`}
      />
    </div>
  );
}
