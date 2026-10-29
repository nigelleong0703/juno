import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ListRowProps {
  /** Leading visual: avatar, shape, icon. */
  leading?: ReactNode;
  /** Primary line. */
  title: ReactNode;
  /** Secondary muted line. */
  description?: ReactNode;
  /** Right-aligned meta on the title line (timestamp, badge). */
  meta?: ReactNode;
  /** Trailing slot, vertically centred (chevron, menu). */
  trailing?: ReactNode;
  /** Unread count; renders a small badge on the meta line. */
  unread?: number;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
  /** Disable the two-line chat layout and keep everything on one line. */
  dense?: boolean;
  /** `radio` for a row that is one choice of a single-select list (it then reports `selected` as checked); default `button`. */
  role?: "button" | "radio";
}

/**
 * Two-line chat/list row: avatar + title + right-aligned meta on line one,
 * one-line muted preview on line two, optional unread badge.
 */
export function ListRow({
  leading,
  title,
  description,
  meta,
  trailing,
  unread,
  selected = false,
  onClick,
  className,
  dense = false,
  role = "button",
}: ListRowProps) {
  const interactive = Boolean(onClick);
  return (
    <div
      data-slot="list-row"
      data-selected={selected || undefined}
      role={interactive ? role : undefined}
      aria-checked={interactive && role === "radio" ? selected : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-150 ease-out",
        interactive && "cursor-pointer",
        selected ? "bg-accent" : interactive && "hover:bg-accent",
        className,
      )}
    >
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {meta && (
              <span className="text-xs text-muted-foreground">{meta}</span>
            )}
            {typeof unread === "number" && unread > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs font-medium text-primary-foreground">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </span>
        </div>
        {!dense && description && (
          <div className="mt-0.5 truncate text-sm text-muted-foreground">{description}</div>
        )}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}
