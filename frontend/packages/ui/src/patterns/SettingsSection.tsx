import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Card-style settings group: header, body and optional footer. */
export function SettingsSection({
  title,
  description,
  children,
  footer,
  className,
}: SettingsSectionProps) {
  return (
    <div
      data-slot="settings-section"
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
    >
      <div className="space-y-1 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-4 border-t border-border px-4 py-3">{children}</div>
      {footer && (
        <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}
