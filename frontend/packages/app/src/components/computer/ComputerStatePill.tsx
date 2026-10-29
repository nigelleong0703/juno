import type { ComputerState } from "@agent-desktop/client";
import { StatusPill, cn } from "@agent-desktop/ui";
import { t } from "../../lib/i18n";
import { computerStateMeta } from "../../lib/status";

export interface ComputerStatePillProps {
  state: ComputerState;
  size?: "sm" | "md";
  className?: string;
}

/** Status pill for a computer's `state` (wired to the single status map in lib/status). */
export function ComputerStatePill({ state, size = "md", className }: ComputerStatePillProps) {
  const meta = computerStateMeta[state];
  return (
    <StatusPill
      className={className}
      size={size}
      tone={meta.tone}
      label={t(meta.label)}
      icon={<meta.icon className={cn("size-3.5", state === "updating" && "animate-spin")} />}
    />
  );
}
