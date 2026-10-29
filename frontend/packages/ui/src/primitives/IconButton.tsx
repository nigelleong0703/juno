import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type IconButtonProps = ComponentProps<typeof Button> & {
  /** Tooltip label and accessible name. Required — icon-only buttons must be labelled. */
  label: string;
  /** Tooltip side. */
  side?: "top" | "right" | "bottom" | "left";
};

/**
 * Icon-only button: a thin wrapper over shadcn `Button size="icon"` that always
 * carries an accessible name and a tooltip. Sizes `sm`/`md`/`lg` map onto the
 * shadcn icon sizes.
 */
export function IconButton({
  label,
  side = "top",
  variant = "ghost",
  size = "md",
  className,
  ...props
}: IconButtonProps) {
  const sizeClass =
    size === "sm" ? "size-7" : size === "lg" ? "size-10" : "size-8";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            data-slot="icon-button"
            variant={variant}
            size="icon"
            aria-label={label}
            className={cn(sizeClass, className)}
            {...props}
          />
        </TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
