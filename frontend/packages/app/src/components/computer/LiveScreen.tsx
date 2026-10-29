import type { Computer } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import type { ReactNode } from "react";
import type { FramebufferSize, LiveScreenTarget } from "./types";
import { NoVncSurface } from "./live/NoVncSurface";
import type { ScreenClipboardBridge } from "./live/screenClipboard";

/**
 * The live picture of an agent's virtual computer (§6). It mounts a real `@novnc/novnc` session
 * against a signed websockify target; with no target it renders the caller's honest placeholder.
 * There is no fabricated fallback desktop.
 *
 * `SCREEN_WIDTH`/`SCREEN_HEIGHT` are only the fallback for placeholders; the live
 * framebuffer size arrives via `onFramebufferSizeChange` and `ComputerView` owns the frame.
 */

/** Fallback frame size for placeholders (SPEC: Debian 13 · Xfce · Chromium, 1364×1024). */
export const SCREEN_WIDTH = 1364;
export const SCREEN_HEIGHT = 1024;
export const SCREEN_ASPECT = SCREEN_WIDTH / SCREEN_HEIGHT;

export interface LiveScreenProps {
  computer: Computer;
  /** Websocket endpoint for the `novnc` adapter. */
  target?: LiveScreenTarget | null;
  /** Watch (true, default) vs control (false) — noVNC only. */
  viewOnly?: boolean;
  /** Rendered in place of the screen when there is no drawable target. */
  empty?: ReactNode;
  className?: string;
  /** Forwarded from the noVNC canvas intrinsic size to the outer aspect frame. */
  onFramebufferSizeChange?: (size: FramebufferSize) => void;
  /** Owner hook for a fresh stream target before reconnecting (see `NoVncSurface`). */
  onReconnect?: () => Promise<LiveScreenTarget>;
  /**
   * Identity of the selected display (the screen id). Threaded to the surface so
   * retained frames never cross displays: same-screen reconnects keep the last
   * frame, a newly selected display starts empty.
   */
  screenKey?: string | null;
  /** The computer clipboard for images and files, bound to this screen (see `NoVncSurface`). */
  clipboard?: ScreenClipboardBridge;
}

export function LiveScreen({
  computer,
  target,
  viewOnly = true,
  empty,
  className,
  onFramebufferSizeChange,
  onReconnect,
  screenKey,
  clipboard,
}: LiveScreenProps) {
  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-[#0b1220]", className)}>
      {target ? (
        <NoVncSurface
          target={target}
          viewOnly={viewOnly}
          onFramebufferSizeChange={onFramebufferSizeChange}
          onReconnect={onReconnect}
          screenKey={screenKey}
          clipboard={clipboard}
        />
      ) : (
        <div className="absolute inset-0">{empty}</div>
      )}

      {computer.state === "updating" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/55">
          <span className="rounded-md bg-black/60 px-3 py-1.5 text-xs text-white/80">Updating…</span>
        </div>
      )}
    </div>
  );
}
