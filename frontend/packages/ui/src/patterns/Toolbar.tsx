import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ToolbarProps {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}

/** A single-row toolbar: leading controls on the left, trailing on the right. */
export function Toolbar({ left, right, className }: ToolbarProps) {
  return (
    <div
      data-slot="toolbar"
      className={cn(
        "flex h-12 items-center justify-between gap-2 border-b border-border px-4",
        className,
      )}
    >
      {left && <div className="flex items-center gap-2">{left}</div>}
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}
