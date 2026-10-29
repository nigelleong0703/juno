import type { Agent, Computer, ScreenRect } from "@agent-desktop/client";
import { cn, Spinner } from "@agent-desktop/ui";
import { BedDouble } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { ControlBanner } from "./ControlBanner";
import { FrameOutline } from "./FrameOutline";
import { LiveScreen, SCREEN_HEIGHT, SCREEN_WIDTH } from "./LiveScreen";
import type { ScreenClipboardBridge } from "./live/screenClipboard";
import "./controlShape.css";
import { tc } from "./i18n";
import { deriveScreenMode, modeIsInteractive } from "./modes";
import { roundedSurface, SCREEN_RADIUS } from "./surface";
import type {
  ComputerViewMode,
  FramebufferSize,
  LiveScreenTarget,
} from "./types";

/**
 * Frames the live screen in one of six modes (§6): watch · control · signin · teach · needs-you ·
 * asleep. The screen fills the pane's width at the fixed 1364×1024 ratio, top-aligned under the
 * asleep. The screen fills the pane's width at the live framebuffer ratio when noVNC reports
 * it (fallback 1364×1024 for placeholders), top-aligned under the banner, with a small
 * inset; any leftover vertical space is the shared panel surface (never a black letterbox, so
 * it reads correctly in the light theme). In control mode it draws the accent outline and the
 * "you have control" banner.
 *
 * It is presentational: `ComputerPane` decides the mode from live state and passes the callbacks.
 */
export interface ComputerViewProps {
  computer: Computer;
  agent?: Agent;
  /**
   * Identity of the selected display (the screen id). The framebuffer ratio follows
   * it so a group member switch never reuses the previous display ratio. It
   * also keys frame retention in the surface: same-screen reconnects keep the
   * last frame, a newly selected display starts empty.
   */
  screenKey?: string | null;
  // External site awaiting a browser sign-in, named explicitly in the banner.
  siteName?: string;
  /** Explicit mode. When omitted it is derived from `computer.state` + `computer.controller`. */
  mode?: ComputerViewMode;
  /**
   * Authoritative input enablement. When omitted it falls back to `modeIsInteractive(mode)` so
   * standalone consumers keep the old behavior; `ComputerPane` passes the real screen lease
   * (user controller + live) so a pending-request banner never gates the keyboard.
   */
  inputEnabled?: boolean;
  /** noVNC endpoint; when present `LiveScreen` uses the `novnc` adapter. */
  target?: LiveScreenTarget | null;
  /**
   * Takeover/return in flight for the SAME screen: the held frame stays mounted
   * under a translucent overlay instead of flashing an empty frame.
   */
  transitioning?: boolean;
  /**
   * Owner hook that refreshes the display + stream ticket and returns the fresh target (RF1);
   * forwarded to `NoVncSurface` so Reconnect never re-dials an expired signed URL.
   */
  onReconnect?: () => Promise<LiveScreenTarget>;
  /** The computer clipboard for images and files, bound to the viewed screen (forwarded to `LiveScreen`). */
  clipboard?: ScreenClipboardBridge;
  /** Seconds elapsed while teaching (REC banner). */
  teachSeconds?: number;
  onTeachStop?: () => void;
  onSigninDone?: () => void;
  onSkipStep?: () => void;
  onContinue?: () => void;
  /**
   * Where the agent is stuck on this screen, in framebuffer pixels (a pending take-over request's
   * `focus.rect`). Outlined for a few seconds when it appears; the frame is not zoomed.
   */
  focusRect?: ScreenRect;
  /** Rendered inside the screen frame when there is nothing truthful to draw. */
  empty?: ReactNode;
  /**
   * The pane's existing control footer (status + handover action). It shares the screen frame's
   * stage so the reference connected shape can join it to the frame's bottom edge while the user
   * holds the lease, and drop it away as a detached pill when the agent drives.
   */
  controlFooter?: ReactNode;
  /**
   * Authoritative screen ownership. When omitted the shape follows the resolved mode, so
   * standalone consumers that pass `mode`/`computer.controller` keep the old behavior; the pane
   * passes its real lease so the connected shape tracks the same truth as the stream ticket.
   */
  userInControl?: boolean;
  /** Rendered directly under the screen (compact resources / current step); the empty space stays below it. */
  footer?: ReactNode;
  className?: string;
}

/** How long the take-over focus outline stays on the live screen. */
const FOCUS_OUTLINE_MS = 6000;

export function ComputerView({
  computer,
  agent,
  screenKey,
  siteName,
  mode,
  inputEnabled,
  target,
  transitioning,
  onReconnect,
  clipboard,
  teachSeconds,
  onTeachStop,
  onSigninDone,
  onSkipStep,
  onContinue,
  empty,
  focusRect,
  controlFooter,
  userInControl,
  footer,
  className,
}: ComputerViewProps) {
  const resolvedMode: ComputerViewMode =
    mode ??
    deriveScreenMode({
      computerState: computer.state,
      userInControl: computer.controller === "user",
      signinPending: false,
      needsYouPending: false,
      teaching: false,
    });

  const interactive = inputEnabled ?? modeIsInteractive(resolvedMode);
  // The connected shape follows ownership, not the visible mode: the explicit lease wins, and
  // otherwise the computer's controller keeps standalone consumers truthful. Mode alone would
  // drop user ownership while a higher-priority mode (signin / needs-you / teach) is showing.
  const userDrivesScreen = userInControl ?? computer.controller === "user";
  // The pane already surfaces control truth in the single pill under the frame, so the
  // informational watch/control banner would only repeat it above the screen. Keep the
  // actionable banners (sign-in, teaching, needs-you) that carry the owner's next step.
  const showActionBanner =
    resolvedMode === "signin" || resolvedMode === "teach" || resolvedMode === "needs-you";
  // The live framebuffer size, tagged with the stream that reported it. The key is the
  // agent (the stream owner, stable across ticket URL rotations) with the endpoint URL as
  // fallback. The frame only uses a size whose key matches the current stream, so a stale
  // canvas can never flash into another agent/target — and ticket rotation for the same
  // agent keeps the ratio instead of flickering back to the 1364x1024 fallback. Derived
  // synchronously during render: no clearing effect, so a fresh report arriving in the same
  // commit as a target change (child observer effects run before parent effects) survives.
  const streamKey = screenKey ?? agent?.id ?? target?.url ?? null;
  const [reported, setReported] = useState<{
    key: string | null;
    size: FramebufferSize;
  } | null>(null);

  const handleFramebufferSizeChange = useCallback(
    (size: FramebufferSize) => {
      if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
      if (size.width <= 0 || size.height <= 0) return;
      setReported((prev) =>
        prev &&
        prev.key === streamKey &&
        prev.size.width === size.width &&
        prev.size.height === size.height
          ? prev
          : { key: streamKey, size },
      );
    },
    [streamKey],
  );
  const framebufferSize =
    target && reported && reported.key === streamKey ? reported.size : null;
  const aspectRatio = framebufferSize
    ? `${framebufferSize.width} / ${framebufferSize.height}`
    : `${SCREEN_WIDTH} / ${SCREEN_HEIGHT}`;

  // The take-over focus outline shows for a few seconds per rect, then fades out.
  const focusKey = focusRect ? `${focusRect.x},${focusRect.y},${focusRect.width},${focusRect.height}` : null;
  const [fadedKey, setFadedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!focusKey) return;
    const timer = setTimeout(() => setFadedKey(focusKey), FOCUS_OUTLINE_MS);
    return () => clearTimeout(timer);
  }, [focusKey]);
  const focusBox =
    focusRect && framebufferSize && focusKey !== fadedKey
      ? {
          left: `${(focusRect.x / framebufferSize.width) * 100}%`,
          top: `${(focusRect.y / framebufferSize.height) * 100}%`,
          width: `${(focusRect.width / framebufferSize.width) * 100}%`,
          height: `${(focusRect.height / framebufferSize.height) * 100}%`,
        }
      : null;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {showActionBanner && (
        <ControlBanner
          mode={resolvedMode}
          agentName={agent?.name}
          siteName={siteName}
          teachSeconds={teachSeconds}
          onTeachStop={onTeachStop}
          onSigninDone={onSigninDone}
          onSkipStep={onSkipStep}
          onContinue={onContinue}
        />
      )}

      {/* The screen fills the width and stays top-aligned; the stage is the shared panel surface
          so the leftover space below is not a black letterbox. The frame sizes from the stage
          width alone: the old height-capped width belonged to the fixed-height tab layout, and
          in the scrolling reference composition it resolves circularly and collapses the honest
          placeholder to zero. Vertical overflow scrolls with the pane instead. */}
      <div className="relative flex min-h-0 flex-1 items-start justify-center bg-panel p-4">
        <div className="flex w-full flex-col items-center">
          {/* w-full keeps the ratio box at stage width even when the screen has nothing to
              draw yet: the honest placeholder is absolutely positioned and contributes no
              intrinsic size, so without it the frame collapses to zero. The stage holds the
              frame and the control footer in one coordinate space so the footer can weld onto
              the frame's bottom edge (controlShape.css). */}
          <div
            className={cn("control-stage relative w-full", controlFooter ? "control-stage--footer" : undefined)}
            style={{ "--screen-ratio": framebufferSize ? framebufferSize.width / framebufferSize.height : SCREEN_WIDTH / SCREEN_HEIGHT } as CSSProperties}
            data-control={userDrivesScreen ? "user" : "agent"}
          >
            {/* UI85: dimensions wrapper around the frame alone (not the stage, which includes the
                footer). It shares the frame's box so the external outline sibling traces the same
                dimensions without clipping the framebuffer. */}
            <div className="control-frame-wrap relative w-full">
              <div
                data-testid="screen-frame"
                className={cn(
                  "control-frame relative w-full overflow-hidden shadow-lg",
                  interactive ? "ring-1 ring-border-strong" : "ring-1 ring-border",
                )}
                style={roundedSurface(SCREEN_RADIUS, { aspectRatio })}
              >
                <LiveScreen
                  computer={computer}
                  target={target}
                  viewOnly={!interactive}
                  empty={empty}
                  onFramebufferSizeChange={handleFramebufferSizeChange}
                  onReconnect={onReconnect}
                  screenKey={screenKey}
                  clipboard={clipboard}
                />
                {focusBox ? (
                  <span
                    data-testid="focus-outline"
                    aria-hidden
                    className="pointer-events-none absolute animate-pulse rounded-md ring-2 ring-foreground"
                    style={focusBox}
                  />
                ) : null}
                {/* Same-screen handover: the held frame stays mounted underneath while the
                    fresh ticket lands. Translucent by design — the screen must remain
                    visible, never a black spinner box. A newly selected display never
                    reaches this branch with another screen pixels: the pane drops the
                    hold on every screen switch. */}
                {transitioning && target && (
                  <div
                    data-testid="screen-transition"
                    className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/60 backdrop-blur-[1px]"
                  >
                    <Spinner className="size-5" />
                    <span className="text-xs text-fg-muted">{tc("computer.stream.connecting")}</span>
                  </div>
                )}
              </div>
              {/* UI85: external ownership stroke. An absolute sibling of the clipped frame (not a
                  child) so no stroke overlaps the pixels; it draws from the tab (bottom centre) up
                  and around both sides to meet at the top centre, then retracts along the same
                  paths. The wrapper contributes the dimensions so the frame box and the
                  framebuffer pixels never move. */}
              <FrameOutline />
            </div>

            {controlFooter ? <div className="control-tab">{controlFooter}</div> : null}
          </div>

          {footer}
        </div>

        {resolvedMode === "asleep" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/85 px-6 text-center backdrop-blur-sm">
            <BedDouble className="size-6 text-fg-subtle" />
            <div className="text-sm font-medium text-fg">{tc("computer.mode.asleep.title")}</div>
            <div className="text-xs text-fg-muted">{tc("computer.mode.asleep.body")}</div>
          </div>
        )}
      </div>
    </div>
  );
}
