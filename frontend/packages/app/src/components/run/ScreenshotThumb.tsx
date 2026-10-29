import { cn } from "@agent-desktop/ui";

export interface ScreenshotThumbProps {
  /** Screenshot reference from a step; rendered deterministically as a fake desktop frame. */
  refId: string;
  agentColor?: number;
  size?: "sm" | "md";
  className?: string;
}

/**
 * A captured-screen thumbnail. The backend supplies only a `screenshotRef` string, so we draw a
 * believable mini desktop (window chrome + page lines) tinted by the agent color. When the real
 * `screen` store lands, swap the body for an `<img>` keyed by the same ref.
 */
export function ScreenshotThumb({ refId, agentColor = 1, size = "sm", className }: ScreenshotThumbProps) {
  // Deterministic line widths so the same step always looks the same.
  const seed = refId.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const lines = [70, 92, 55, 84, 62];
  const tint = `var(--agent-${agentColor})`;

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-sm border border-border bg-bg",
        size === "sm" ? "h-9 w-14" : "h-16 w-24",
        className,
      )}
      aria-hidden="true"
    >
      {/* window title bar */}
      <div className="flex h-2 items-center gap-0.5 border-b border-border bg-bg-subtle px-1">
        <span className="size-1 rounded-full" style={{ background: tint, opacity: 0.8 }} />
        <span className="size-1 rounded-full bg-border-strong" />
        <span className="size-1 rounded-full bg-border-strong" />
      </div>
      {/* page body */}
      <div className="flex h-full flex-col gap-1 p-1.5">
        <div className="h-1.5 w-2/3 rounded-full" style={{ background: tint, opacity: 0.55 }} />
        {lines.map((width, index) => (
          <div
            key={index}
            className="h-1 rounded-full bg-border-strong"
            style={{ width: `${((width + seed) % 60) + 30}%`, opacity: 0.7 }}
          />
        ))}
      </div>
    </div>
  );
}
