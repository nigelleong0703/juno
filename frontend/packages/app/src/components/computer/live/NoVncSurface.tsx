import { Button, cn, Spinner, toast } from "@agent-desktop/ui";
import { AlertTriangle, ClipboardPaste, Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { tc } from "../i18n";
import type { FramebufferSize, LiveScreenTarget } from "../types";
import { frameCanvasPainted, useRfb } from "./useRfb";
import { FRAME_SNAPSHOT_LAYER_ATTR } from "./useFrameSnapshot";
import {
  browserClipboard,
  copyFromComputer,
  pasteImageToComputer,
  saveFilesToComputer,
  type ClipboardNote,
  type ScreenClipboardBridge,
} from "./screenClipboard";

/** Ctrl+C takes a moment to reach the computer's clipboard before it can be read. */
const COPY_SETTLE_MS = 350;

function showClipboardNote(note: ClipboardNote): void {
  if (note.error) toast.error(note.message);
  else toast(note.message);
}

/** A paste event aimed at a text field belongs to that field, not to the computer. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Used when no bridge is bound: every read fails, so Copy falls back to the remote's cut-text. */
const NO_SIDE_CHANNEL: ScreenClipboardBridge = {
  copy: () => Promise.reject(new Error("the computer clipboard is not connected")),
  paste: () => Promise.reject(new Error("the computer clipboard is not connected")),
};

export interface NoVncSurfaceProps {
  target: LiveScreenTarget;
  /** Watch (true) vs control (false). */
  viewOnly?: boolean;
  /** The computer's clipboard for images and files (M-CLIP), bound to this screen by the product. */
  clipboard?: ScreenClipboardBridge;
  className?: string;
  /** Fires with the canvas intrinsic size (width/height attributes) when it arrives or changes. */
  onFramebufferSizeChange?: (size: FramebufferSize) => void;
  /**
   * Owner hook that returns a fresh, authorized stream target (RF1). The signed ticket behind
   * `target.url` expires (~5 min), so a visible Reconnect must ask the owner to refresh the
   * display and ticket rather than dial the expired URL again. The resolved URL is compared with
   * the live one: a changed ticket reconnects through the `target` prop, an unchanged (or
   * already committed) URL forces a local reconnect. Omitted only by standalone consumers
  * (tests, previews); the product always injects it from `ComputerPane`.
   */
  onReconnect?: () => Promise<LiveScreenTarget>;
  /**
   * Identity of the selected display (the screen id). A newly selected display
   * remounts the whole session so no canvas — and no socket — survives an agent
   * switch. Same-screen ticket rotations reuse the session below, which retires
   * (never destroys) across URLs until the fresh session paints.
   */
  screenKey?: string | null;
}

/**
 * Real noVNC surface (§6/§9): mounts `@novnc/novnc`'s RFB into per-session layers via `useRfb`
 * and overlays connection state. This is what talks to our self-hosted E2B websockify endpoint.
 *
 * The gray spinner is owned by paint, not by the protocol handshake: a rotated ticket keeps the
 * held frame and the connecting veil until the fresh canvas actually draws, a bounded paint
 * failure reports a truthful retry, and a newly selected display never reveals another screen.
 *
 * Reports the remote framebuffer's intrinsic canvas size so the outer frame can match it
 * without letterboxing. Scaling and pointer coordinates stay with RFB (`scaleViewport`);
 * this surface adds no size CSS to the canvas itself.
 */
export function NoVncSurface({ screenKey, ...rest }: NoVncSurfaceProps) {
  // Privacy by construction: a screen switch remounts the session, so the
  // previous display pixels and socket cannot survive into the new display.
  return <InnerSurface key={screenKey ?? "shared"} {...rest} />;
}

function InnerSurface({
  target,
  viewOnly = true,
  className,
  onFramebufferSizeChange,
  onReconnect,
  clipboard = NO_SIDE_CHANNEL,
}: Omit<NoVncSurfaceProps, "screenKey">) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The remote's cut-text (text only). Copy reads the computer's clipboard itself; this is only the fallback for an older
  // computer that cannot answer that read, so it is kept while a copy is in flight and never shown on its own.
  const cutTextRef = useRef<string | null>(null);
  const onClipboard = useCallback((text: string) => {
    cutTextRef.current = text;
  }, []);
  const { state, painted, reconnect, copy, paste, pressPaste } = useRfb({ containerRef, target, viewOnly, onClipboard });

  // Copy: Ctrl+C on the computer, then its clipboard (text, an image or a file) is brought here.
  const copyFromDevice = () => {
    cutTextRef.current = null;
    copy();
    void new Promise<void>((resolve) => setTimeout(resolve, COPY_SETTLE_MS))
      .then(() => copyFromComputer(clipboard, browserClipboard, () => cutTextRef.current))
      .then(showClipboardNote);
  };

  // Paste: an image on this device goes onto the computer's clipboard and Ctrl+V pastes it; text keeps the VNC path.
  const pasteFromDevice = () => {
    void (async () => {
      const outcome = await pasteImageToComputer(clipboard, browserClipboard);
      if (outcome.kind === "image") return pressPaste();
      if (outcome.kind === "error") return showClipboardNote(outcome.note);
      try {
        const text = await navigator.clipboard.readText();
        if (text) paste(text);
        else toast(tc("computer.clipboard.nothingToPaste"));
      } catch {
        toast.error(tc("computer.clipboard.denied"));
      }
    })();
  };

  // Files pasted while the user holds the screen go to the computer's Downloads (a browser exposes files only in a paste event).
  useEffect(() => {
    if (viewOnly || !clipboard) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0 || isEditableTarget(event.target)) return;
      event.preventDefault();
      void saveFilesToComputer(clipboard, files).then(showClipboardNote);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [clipboard, viewOnly]);
  // A frame was drawn for THIS display: the connecting veil stays translucent so the
  // retained frame shows through. Fresh displays keep the opaque veil. Sticky across
  // rotations; a screen switch remounts this component and resets it.
  const [hadFrame, setHadFrame] = useState(false);
  useEffect(() => {
    if (painted) setHadFrame(true);
  }, [painted]);
  const callbackRef = useRef<((size: FramebufferSize) => void) | null>(null);
  // Synchronous guard: a double click lands twice before React disables the button, so the ref
  // (not the state) decides whether an attempt is already in flight.
  const reconnectPendingRef = useRef(false);
  const [reconnectPending, setReconnectPending] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  // The URL the surface is currently dialing, kept for the post-refresh comparison. Written in an
  // effect so it always reflects the committed prop, never a render still in progress.
  const currentUrlRef = useRef(target.url);
  useEffect(() => {
    currentUrlRef.current = target.url;
  }, [target.url]);

  const handleReconnect = useCallback(() => {
    if (reconnectPendingRef.current) return;
    if (!onReconnect) {
      reconnect();
      return;
    }
    reconnectPendingRef.current = true;
    setReconnectError(null);
    setReconnectPending(true);
    void onReconnect()
      .then((fresh) => {
        // A changed ticket reconnects through the `target` prop effect; re-dialing here would race
        // it with the expired URL. An unchanged (or already committed) URL has no effect left to
        // run, so force the local reconnect.
        if (fresh.url !== currentUrlRef.current) return;
        reconnect();
      })
      .catch((cause: unknown) => {
        setReconnectError(
          cause instanceof Error ? cause.message : "Could not refresh the stream.",
        );
      })
      .finally(() => {
        reconnectPendingRef.current = false;
        setReconnectPending(false);
      });
  }, [onReconnect, reconnect]);

  useEffect(() => {
    callbackRef.current = onFramebufferSizeChange ?? null;
  }, [onFramebufferSizeChange]);

  const targetUrl = target.url;
  useEffect(() => {
    const observed = containerRef.current;
    if (observed === null) return;
    const el: HTMLElement = observed;
    let disposed = false;
    let lastWidth = 0;
    let lastHeight = 0;

    function readSize(canvas: HTMLCanvasElement): FramebufferSize | null {
      const width = canvas.width;
      const height = canvas.height;
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }

    function maybeReport(canvas: HTMLCanvasElement | null): void {
      if (disposed || !canvas) return;
      const size = readSize(canvas);
      if (!size) return;
      if (size.width === lastWidth && size.height === lastHeight) return;
      lastWidth = size.width;
      lastHeight = size.height;
      callbackRef.current?.(size);
    }

    // Only a canvas that has actually painted is a real framebuffer. A fresh session mounts
    // noVNC's unready canvas (0x0 in the real client; a transient intrinsic size in probes)
    // before the first update, so adopting its size would momentarily resize the frame. Scan
    // back to the newest painted canvas: the held frame's confirmed size survives a rotation,
    // and the fresh size lands only once its pixels do.
    function liveCanvas(): HTMLCanvasElement | null {
      const list = el.querySelectorAll("canvas");
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const canvas = list.item(i);
        // The frozen last-frame layer is not a live framebuffer, so it never sets the ratio.
        if (
          canvas instanceof HTMLCanvasElement &&
          canvas.dataset[FRAME_SNAPSHOT_LAYER_ATTR] === undefined &&
          frameCanvasPainted(canvas)
        ) {
          return canvas;
        }
      }
      return null;
    }

    maybeReport(liveCanvas());

    // One read per batch, always the newest painted canvas: an attribute mutation on a stale
    // canvas left behind by a reconnect can never regress the frame after the fresh canvas has
    // reported. Arrivals (including nested/subtree ones) are covered because the new canvas is
    // the newest by the time the batch runs.
    const observer = new MutationObserver(() => {
      if (disposed) return;
      maybeReport(liveCanvas());
    });
    observer.observe(el, {
      childList: true,
      attributes: true,
      subtree: true,
      attributeFilter: ["width", "height"],
    });
    return () => {
      disposed = true;
      observer.disconnect();
      lastWidth = 0;
      lastHeight = 0;
    };
    // `painted` re-runs the read: a fresh session's first pixels can arrive without a new
    // width/height attribute mutation (same dimensions, later draw), so the mutation observer
    // alone would never publish the fresh framebuffer's real ratio.
  }, [targetUrl, painted]);

  const reconnectControl = (
    <button
      type="button"
      onClick={handleReconnect}
      disabled={reconnectPending}
      className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs text-white/90 hover:bg-white/15 disabled:opacity-60"
    >
      {reconnectPending ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
      {reconnectPending ? "Reconnecting…" : "Reconnect"}
    </button>
  );

  // The veil tracks paint, not the RFB handshake: a "connected" session whose canvas has not
  // drawn yet must still read as connecting, so the held frame never flashes to a blank one.
  const showConnecting =
    !painted && state.state !== "error" && state.state !== "disconnected";

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-[#0b1220]", className)}>
      <div
        ref={containerRef}
        data-testid="novnc-container"
        className="absolute inset-0 flex items-center justify-center"
      />

      {!viewOnly && state.state === "connected" && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1 rounded-full bg-black/60 p-1 backdrop-blur">
          <Button variant="ghost" size="sm" className="rounded-full text-white hover:text-white" onClick={copyFromDevice}>
            <Copy className="size-3.5" />
            {tc("computer.clipboard.copy")}
          </Button>
          <Button variant="ghost" size="sm" className="rounded-full text-white hover:text-white" onClick={pasteFromDevice}>
            <ClipboardPaste className="size-3.5" />
            {tc("computer.clipboard.paste")}
          </Button>
        </div>
      )}

      {showConnecting && (
        <div
          data-testid={hadFrame ? "screen-reconnect" : undefined}
          className={
            hadFrame
              ? "absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/35 text-white/80"
              : "absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-white/80"
          }
        >
          <Spinner className="size-5" />
          <span className="text-xs">Connecting to the computer…</span>
        </div>
      )}

      {state.state === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/30 px-6 text-center text-white/85">
          <AlertTriangle className="size-5 text-warning" />
          <span className="text-xs">{state.message ?? "The computer stream failed."}</span>
          {reconnectError && <span className="text-xs text-warning">{reconnectError}</span>}
          {reconnectControl}
        </div>
      )}

      {state.state === "disconnected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/35 text-white/80">
          <span className="text-xs">
            {state.clean ? "Disconnected." : "The stream stopped unexpectedly."}
          </span>
          {reconnectError && <span className="text-xs text-warning">{reconnectError}</span>}
          {reconnectControl}
        </div>
      )}
    </div>
  );
}
