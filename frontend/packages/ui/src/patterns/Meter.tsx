import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface MeterProps {
  value: number;
  min?: number;
  max?: number;
  label?: ReactNode;
  /** Explicit text shown on the right of the label; defaults to a percentage. */
  valueLabel?: ReactNode;
  formatValue?: (value: number, max: number) => ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
  className?: string;
  showValue?: boolean;
}

const toneClasses = {
  default: "bg-foreground",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
} as const;

/** Determinate meter with role="meter" and full ARIA value attributes. */
export function Meter({
  value,
  min = 0,
  max = 100,
  label,
  valueLabel,
  formatValue,
  tone = "default",
  className,
  showValue = true,
}: MeterProps) {
  const clamped = Math.min(Math.max(value, min), max);
  const percent = max === min ? 0 : ((clamped - min) / (max - min)) * 100;
  const display =
    valueLabel ?? (formatValue ? formatValue(clamped, max) : `${Math.round(percent)}%`);

  return (
    <div data-slot="meter" className={cn("flex flex-col gap-1.5", className)}>
      {(label || (showValue && display)) && (
        <div className="flex items-baseline justify-between gap-2">
          {label && <span className="text-sm text-foreground">{label}</span>}
          {showValue && display && (
            <span className="text-xs tabular-nums text-muted-foreground">{display}</span>
          )}
        </div>
      )}
      <div
        role="meter"
        aria-valuenow={clamped}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={typeof display === "string" ? display : undefined}
        aria-label={typeof label === "string" ? label : undefined}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-out",
            toneClasses[tone],
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
