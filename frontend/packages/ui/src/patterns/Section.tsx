import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/** Titled content block: header row plus body, with hairline separation. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: SectionProps) {
  return (
    <section data-slot="section" className={cn("flex flex-col gap-3", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("min-w-0", contentClassName)}>{children}</div>
    </section>
  );
}
