import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SegmentedControlItem {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
}

export interface SegmentedControlProps {
  items: SegmentedControlItem[];
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  disabled?: boolean;
  /** Accessible name for the group. */
  "aria-label"?: string;
  /** Stretch to the container width with equal segments (scope switches in panels). */
  fill?: boolean;
  /** Icon-only segments: the label becomes the accessible name and a tooltip (needs a string label and an icon). */
  iconOnly?: boolean;
}

/**
 * Segmented control built on shadcn `ToggleGroup` — a single-select group as a
 * muted pill track with the selected segment as a raised pill (no borders).
 */
export function SegmentedControl({
  items,
  value,
  onValueChange,
  className,
  disabled = false,
  "aria-label": ariaLabel,
  fill = false,
  iconOnly = false,
}: SegmentedControlProps) {
  return (
    <ToggleGroup
      data-slot="segmented-control"
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange?.(next);
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      variant="default"
      size="sm"
      className={cn(
        "h-8 rounded-full bg-muted p-0.5",
        fill && "flex w-full",
        className,
      )}
    >
      {items.map((item) => {
        const segment = (
          <ToggleGroupItem
            key={item.value}
            value={item.value}
            aria-label={iconOnly && typeof item.label === "string" ? item.label : undefined}
            className={cn(
              "h-full gap-2 rounded-full border-0 px-3 text-[13px] font-medium text-muted-foreground shadow-none data-[spacing=0]:rounded-full data-[spacing=0]:first:rounded-l-full data-[spacing=0]:last:rounded-r-full data-[state=on]:bg-interactive-selected data-[state=on]:text-foreground",
              fill && "flex-1",
            )}
          >
            {item.icon}
            {iconOnly ? null : <span>{item.label}</span>}
          </ToggleGroupItem>
        );
        if (!iconOnly) return segment;
        return (
          <Tooltip key={item.value}>
            <TooltipTrigger asChild>{segment}</TooltipTrigger>
            <TooltipContent>{item.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}
