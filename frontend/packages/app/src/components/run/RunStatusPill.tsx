import type { RunStatus } from "@agent-desktop/client";
import { StatusPill } from "@agent-desktop/ui";
import { cn } from "@agent-desktop/ui";
import { runStatusMeta, statusLabel } from "../../lib/status";

export interface RunStatusPillProps {
  status: RunStatus;
  size?: "sm" | "md";
  className?: string;
}

/** Status label for a Run, driven by the single status→tone/icon map. */
export function RunStatusPill({ status, size = "sm", className }: RunStatusPillProps) {
  const meta = runStatusMeta[status];
  const Icon = meta.icon;
  return (
    <StatusPill
      className={className}
      tone={meta.tone}
      size={size}
      icon={<Icon className={cn("size-3.5", status === "running" && "animate-spin")} />}
      label={statusLabel(meta)}
    />
  );
}
