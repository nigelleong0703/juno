import { cn } from "@agent-desktop/ui";
import type { ReactNode } from "react";
import { CARD_SURFACE, SECTION_LABEL } from "../../components/page/PageFrame";

/** A settings card with a section label; `action` sits on the title line (e.g. an "Add" button). */
export function Group({
  title,
  description,
  action,
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      {title || description || action ? (
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className={SECTION_LABEL}>{title}</h2>}
            {description && <p className="px-1 text-xs text-fg-subtle">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      ) : null}
      <div className={cn("p-1.5", CARD_SURFACE)}>{children}</div>
    </section>
  );
}

export function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl px-2.5 py-2">
      <div className="min-w-0">
        <div className="text-sm text-fg">{label}</div>
        {description && <div className="text-xs text-fg-subtle">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
