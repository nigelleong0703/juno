import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../primitives";
import { cn } from "@/lib/utils";

export interface FilterChipProps {
  label: ReactNode;
  value?: string;
  active?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  icon?: ReactNode;
  className?: string;
}

/**
 * Pill-shaped filter chip. The toggle is its own button so its accessible name
 * is exactly the label; removal is a separate sibling button.
 */
export function FilterChip({
  label,
  active = false,
  onClick,
  onRemove,
  icon,
  className,
}: FilterChipProps) {
  return (
    <div
      data-slot="filter-chip"
      className={cn(
        "inline-flex items-center rounded-full border transition-colors duration-150 ease-out",
        active ? "border-transparent" : "border-border",
        className,
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          "inline-flex items-center gap-2 rounded-full py-1 text-sm transition-colors",
          onRemove ? "pl-3 pr-1" : "px-3",
          active
            ? "bg-accent-subtle text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {icon && <span className="shrink-0">{icon}</span>}
        <span>{label}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label="Remove filter"
          onClick={onRemove}
          className="pr-2 pl-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

export interface FilterBarProps {
  children: ReactNode;
  sort?: ReactNode;
  viewSwitcher?: ReactNode;
  onClear?: () => void;
  className?: string;
}

/** Row of filter chips plus optional sort and view-switcher slots. */
export function FilterBar({
  children,
  sort,
  viewSwitcher,
  onClear,
  className,
}: FilterBarProps) {
  return (
    <div
      data-slot="filter-bar"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <div className="ml-auto flex items-center gap-2">
        {sort}
        {viewSwitcher}
        {onClear && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear all
          </Button>
        )}
      </div>
    </div>
  );
}
