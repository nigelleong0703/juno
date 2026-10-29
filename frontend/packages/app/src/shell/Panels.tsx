import { cn } from "@agent-desktop/ui";
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useRef } from "react";
import { BROWSER_RAIL_WIDTH_PX, NATIVE_MAC_RAIL_WIDTH_PX } from "../lib/windowChrome";

/**
 * The shell's split layout (UF6 reference shell): an actual three-column CSS
 * Grid — chat list | conversation | computer — whose tracks the shell sizes
 * in pixels from state. The conversation track is the only flexible one
 * (`minmax(0, 1fr)`); the side tracks hold their pixels while the window
 * resizes. Separators are absolute 8px overlays centred on the column
 * boundaries — never grid tracks, so the grid holds exactly three tracks
 * (no gap-reserved divider track).
 * Only the computer boundary draws a resting hairline (see app.css
 * `.shell-divider`); every separator stays draggable by pointer and
 * resizable by keyboard (arrows move 8px, shift+arrows 24px).
 */

/**
 * Reference rail (UF6): the collapsed chat list is an 84px avatar rail in the
 * browser build. Native Mac widens it to 96px so the 60px traffic-light group
 * sits with equal 18px margins (see lib/windowChrome.ts); both stay single
 * sources there.
 */
export const SHELL_RAIL_WIDTH = BROWSER_RAIL_WIDTH_PX;
export const NATIVE_MAC_RAIL_WIDTH = NATIVE_MAC_RAIL_WIDTH_PX;

export interface PanelGroupProps {
  children: ReactNode;
  id?: string;
  style?: CSSProperties;
  "data-animating"?: string;
  className?: string;
}

export function PanelGroup({ children, className, ...props }: PanelGroupProps) {
  return (
    <div
      data-slot="panel-group"
      role="none"
      className={cn("shell-grid h-full w-full", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface PanelProps {
  children: ReactNode;
  id?: string;
  style?: CSSProperties;
  className?: string;
  hidden?: boolean;
  /** The column is the panel beside the icon rail: the chrome tone shows behind its corners. */
  "data-rail-panel"?: string;
}

export function PanelComponent({ children, className, ...props }: PanelProps) {
  return (
    <div
      data-slot="panel"
      data-panel=""
      className={cn("min-h-0 min-w-0 overflow-hidden", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface PanelSeparatorProps {
  className?: string;
  style?: CSSProperties;
  onDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Pixel delta from a pointer drag (positive = rightward). */
  onResizeBy?: (dx: number) => void;
  /** Fired when a drag or keyboard resize sequence ends. */
  onCommit?: () => void;
  label?: string;
  /**
   * Draw the resting 0.5px hairline (the deliberate computer boundary).
   * Omit it and the boundary stays line-free at rest, separating by
   * background tone alone with only a hover/drag indicator.
   */
  restingLine?: boolean;
  /**
   * Strip every decorative pseudo-element in all states (sidebar/chat
   * boundary): no line at rest, on hover, or while dragging. The 8px hit
   * target, cursor, pointer drag and keyboard resizing stay; focus uses a
   * plain target outline. Takes precedence over `restingLine`.
   */
  bare?: boolean;
  /** Accessible slider value plumbing (omitted while undefined). */
  valueNow?: number;
  valueMin?: number;
  valueMax?: number;
  valueText?: string;
  /** Ids of the panels this handle resizes. */
  controls?: string;
}

/** The divider between two grid columns: transparent 8px hit area, indicator on interaction. */
export function PanelSeparator({
  className,
  style,
  onDoubleClick,
  onResizeBy,
  onCommit,
  label = "Resize panels",
  restingLine = false,
  bare = false,
  valueNow,
  valueMin,
  valueMax,
  valueText,
  controls,
}: PanelSeparatorProps) {
  const dragStartX = useRef<number | null>(null);

  const endDrag = (commit: boolean) => {
    dragStartX.current = null;
    if (commit) onCommit?.();
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragStartX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStartX.current === null) return;
    const dx = event.clientX - dragStartX.current;
    dragStartX.current = event.clientX;
    onResizeBy?.(dx);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 24 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResizeBy?.(-step);
      onCommit?.();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onResizeBy?.(step);
      onCommit?.();
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      aria-valuetext={valueText}
      aria-controls={controls}
      tabIndex={0}
      data-slot="panel-separator"
      className={cn(
        "shell-divider",
        restingLine && !bare && "shell-divider-line",
        bare && "shell-divider-bare",
        className,
      )}
      style={style}
      onDoubleClick={onDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={() => endDrag(true)}
      onPointerCancel={() => endDrag(false)}
      onKeyDown={handleKeyDown}
    />
  );
}
