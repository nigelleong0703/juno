import type { ComponentProps } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

type Percent = number | `${number}%`;

/** react-resizable-panels v4 reads bare numbers as PIXELS; the product's old API
 * passed percentages. Convert numeric values to percentage strings. */
function toPercent(value: Percent | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}%` : value;
}

export interface ResizablePanelsProps
  extends Omit<ComponentProps<typeof ResizablePanelGroup>, "children"> {
  /** Legacy prop name for `orientation`. */
  direction?: "horizontal" | "vertical";
  className?: string;
  children: React.ReactNode;
}

/** Draggable split layout (shadcn Resizable). */
export function ResizablePanels({
  direction,
  orientation,
  className,
  children,
  ...props
}: ResizablePanelsProps) {
  return (
    <ResizablePanelGroup
      data-slot="resizable-panels"
      orientation={orientation ?? direction ?? "horizontal"}
      className={className}
      {...props}
    >
      {children}
    </ResizablePanelGroup>
  );
}

export interface ResizablePanelProps
  extends Omit<
    ComponentProps<typeof ResizablePanel>,
    "defaultSize" | "minSize" | "maxSize" | "children"
  > {
  defaultSize?: Percent;
  minSize?: Percent;
  maxSize?: Percent;
  className?: string;
  children: React.ReactNode;
}

export function ResizablePanelComponent({
  defaultSize,
  minSize,
  maxSize,
  className,
  children,
  ...props
}: ResizablePanelProps) {
  return (
    <ResizablePanel
      data-slot="resizable-panel"
      defaultSize={toPercent(defaultSize)}
      minSize={toPercent(minSize)}
      maxSize={toPercent(maxSize)}
      className={className}
      {...props}
    >
      {children}
    </ResizablePanel>
  );
}

export { ResizableHandle };
export { ResizablePanelComponent as ResizablePanel };
