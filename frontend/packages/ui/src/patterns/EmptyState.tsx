import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  /**
   * Centre the block (inside panes, cards and full-screen states). The default is left-aligned
   * so it lines up under a page heading the way the lists do.
   */
  centered?: boolean;
}

/** Empty placeholder: a 15px semibold title, one muted 14px line and an optional pill action. No icon. */
export function EmptyState({ title, description, action, className, centered = false }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col gap-1 px-1 py-4",
        centered ? "items-center justify-center px-6 py-12 text-center" : "items-start text-left",
        className,
      )}
    >
      <div className="text-[15px] font-semibold leading-snug text-foreground">{title}</div>
      {description && <div className="max-w-sm text-[14px] leading-5 text-muted-foreground">{description}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
