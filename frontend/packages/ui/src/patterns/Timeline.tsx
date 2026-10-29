import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TimelineItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  timestamp?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
}

export interface TimelineProps {
  items: TimelineItem[];
  className?: string;
}

const dotTone = {
  default: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
} as const;

/** Vertical event list with connector line and toned dots. */
export function Timeline({ items, className }: TimelineProps) {
  return (
    <ol data-slot="timeline" className={cn("flex flex-col", className)}>
      {items.map((item, i) => (
        <li key={item.id} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span
              className={cn(
                "mt-1.5 size-2 shrink-0 rounded-full",
                dotTone[item.tone ?? "default"],
              )}
            />
            {i < items.length - 1 && <span className="w-px flex-1 bg-border" />}
          </div>
          <div className={cn("min-w-0 flex-1", i < items.length - 1 && "pb-5")}>
            <div className="flex items-center gap-2">
              {item.icon}
              <span className="text-sm font-medium text-foreground">{item.title}</span>
              {item.timestamp && (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {item.timestamp}
                </span>
              )}
            </div>
            {item.description && (
              <div className="mt-0.5 text-sm text-muted-foreground">{item.description}</div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
