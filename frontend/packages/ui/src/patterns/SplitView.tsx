import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SplitViewProps {
  /** The list column (it scrolls on its own). */
  list: ReactNode;
  /** The selected item's pane; without one `placeholder` shows, or the list fills the width when there is no placeholder. */
  detail?: ReactNode;
  /** Quiet text for the empty pane. */
  placeholder?: ReactNode;
  /** List column width in px. */
  listWidth?: number;
  className?: string;
}

/** List + detail, side by side: a fixed list column and a pane that takes the rest. Each side scrolls separately. */
export function SplitView({ list, detail, placeholder, listWidth = 380, className }: SplitViewProps) {
  const fill = !detail && !placeholder;
  return (
    <div data-slot="split-view" className={cn("flex min-h-0 flex-1", className)}>
      <div
        data-slot="split-view-list"
        style={fill ? undefined : { width: listWidth }}
        className={cn("min-h-0 overflow-y-auto", fill ? "flex-1" : "shrink-0 border-r border-border")}
      >
        {list}
      </div>
      {fill ? null : (
        <div data-slot="split-view-detail" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {detail ?? <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{placeholder}</div>}
        </div>
      )}
    </div>
  );
}
