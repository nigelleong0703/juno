import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent";

export interface StatusPillProps {
  tone?: StatusTone;
  /** Visible label. Also accepts `children`. */
  label?: ReactNode;
  children?: ReactNode;
  /** Custom leading glyph; replaces the default status dot. */
  icon?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}

const toneClasses: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  accent: "bg-accent-subtle text-foreground",
};

const dotColors: Record<StatusTone, string> = {
  neutral: "var(--muted-foreground)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  info: "var(--info)",
  accent: "var(--foreground)",
};

/**
 * Small status pill. Colour carries meaning only through `tone`; a status dot
 * is shown unless a custom `icon` replaces it.
 */
export function StatusPill({
  tone = "neutral",
  label,
  children,
  icon,
  size = "md",
  className,
}: StatusPillProps) {
  return (
    <span
      data-slot="status-pill"
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium",
        size === "sm" ? "text-xs" : "text-sm",
        toneClasses[tone],
        className,
      )}
    >
      {icon ? (
        <i className="inline-flex shrink-0 items-center">{icon}</i>
      ) : (
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: dotColors[tone] }}
        />
      )}
      <span>{label ?? children}</span>
    </span>
  );
}
