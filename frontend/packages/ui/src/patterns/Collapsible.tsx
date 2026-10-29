import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  Collapsible as CollapsibleRoot,
  CollapsibleContent as CollapsibleContentPrimitive,
  CollapsibleTrigger as CollapsibleTriggerPrimitive,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** Thin wrapper over the shadcn Collapsible root. */
export const Collapsible = CollapsibleRoot;

export interface CollapsibleTriggerProps
  extends ComponentProps<typeof CollapsibleTriggerPrimitive> {
  children: ReactNode;
}

/** Header-style trigger with a chevron that rotates when open. */
export function CollapsibleTrigger({
  className,
  children,
  ...props
}: CollapsibleTriggerProps) {
  return (
    <CollapsibleTriggerPrimitive
      data-slot="collapsible-trigger"
      className={cn(
        "group inline-flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground",
        "transition-colors hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-90" />
      {children}
    </CollapsibleTriggerPrimitive>
  );
}

export interface CollapsibleContentProps
  extends ComponentProps<typeof CollapsibleContentPrimitive> {
  children: ReactNode;
}

export function CollapsibleContent({
  className,
  children,
  ...props
}: CollapsibleContentProps) {
  return (
    <CollapsibleContentPrimitive
      data-slot="collapsible-content"
      className={cn("overflow-hidden", className)}
      {...props}
    >
      <div className="px-3 py-2">{children}</div>
    </CollapsibleContentPrimitive>
  );
}
