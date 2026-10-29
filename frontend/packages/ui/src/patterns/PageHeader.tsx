import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  back?: ReactNode;
  /** Sits in the middle of the header row: the page's agent scope. */
  scope?: ReactNode;
  /** Spans the whole width (split list/detail pages) instead of the centred column. */
  fullWidth?: boolean;
  className?: string;
}

/** Page header: title, subtitle, right-aligned actions and an optional tab strip. */
export function PageHeader({
  title,
  subtitle,
  actions,
  tabs,
  back,
  scope,
  fullWidth = false,
  className,
}: PageHeaderProps) {
  return (
    <div data-slot="page-header" className={cn("relative z-10 shrink-0", className)}>
      <div className={cn("relative flex min-h-[72px] items-center justify-between gap-4 px-5 pb-3 pt-4", !fullWidth && "mx-auto w-full max-w-4xl")}>
        <div className="flex min-w-0 items-center gap-3">
          {back && <div className="shrink-0">{back}</div>}
          <div className="min-w-0">
            <h1 className="truncate text-[28px] font-bold leading-tight tracking-[-0.01em] text-foreground">{title}</h1>
            {subtitle && (
              <div className="truncate pt-0.5 text-sm text-muted-foreground">{subtitle}</div>
            )}
          </div>
        </div>
        {scope && <div className="absolute left-1/2 top-1 z-10 -translate-x-1/2">{scope}</div>}
        <div className="flex shrink-0 items-center justify-end gap-2">{actions}</div>
      </div>
      {tabs && <div className={cn("px-4", !fullWidth && "mx-auto w-full max-w-4xl")}>{tabs}</div>}
    </div>
  );
}
