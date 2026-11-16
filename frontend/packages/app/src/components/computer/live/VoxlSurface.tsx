import { cn, Spinner } from "@agent-desktop/ui";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { tc } from "../i18n";
import type { LiveScreenTarget } from "../types";
import { useVoxlSession } from "./useVoxlSession";

/** The voxl page has this long to load before the surface offers a Reconnect. */
export const VOXL_LOAD_TIMEOUT_MS = 20_000;

export interface VoxlSurfaceProps {
  target: LiveScreenTarget;
  /** Watching: the iframe takes no pointer or focus (the server already serves a read-only instance). */
  viewOnly?: boolean;
  className?: string;
  /** Owner hook returning a fresh, authorized stream target; without it no Reconnect control is drawn. */
  onReconnect?: () => Promise<LiveScreenTarget>;
  /** A newly selected display remounts the whole session. */
  screenKey?: string | null;
}

/**
 * The voxl player (§6): voxl's own web client (H.264 over WebCodecs, input, clipboard, resize)
 * embedded in an iframe. The ticket lives in the page path and is verified by the server, so
 * this surface only decides WHEN to (re)load it; see `useVoxlSession`.
 */
export function VoxlSurface({ screenKey, ...rest }: VoxlSurfaceProps) {
  return <InnerSurface key={screenKey ?? "shared"} {...rest} />;
}

function InnerSurface({ target, viewOnly = true, className, onReconnect }: Omit<VoxlSurfaceProps, "screenKey">) {
  const { src, attempt, reload } = useVoxlSession(target);
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), VOXL_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [src, attempt]);

  const reconnect = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    // Without an owner hook the newest ticket the pane handed us is the best available.
    const fresh = onReconnect ? onReconnect() : Promise.resolve(target);
    void fresh
      .then((next) => reload(next.voxlUrl ?? target.voxlUrl ?? src))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not refresh the stream."))
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  }, [onReconnect, reload, src, target]);

  const failed = timedOut && !loaded;
  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-black", className)}>
      <iframe
        key={attempt}
        data-testid="voxl-frame"
        title={tc("computer.header.title")}
        src={src}
        allow="clipboard-read; clipboard-write; fullscreen"
        referrerPolicy="no-referrer"
        tabIndex={viewOnly ? -1 : 0}
        onLoad={() => setLoaded(true)}
        className={cn("absolute inset-0 h-full w-full border-0", viewOnly && "pointer-events-none")}
      />

      {!loaded && !failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-white/80">
          <Spinner className="size-5" />
          <span className="text-xs">{tc("computer.stream.connecting")}</span>
        </div>
      )}

      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/30 px-6 text-center text-white/85">
          <AlertTriangle className="size-5 text-warning" />
          <span className="text-xs">The computer stream failed.</span>
          {error && <span className="text-xs text-warning">{error}</span>}
          <ReconnectButton pending={pending} onClick={reconnect} />
        </div>
      )}

      {onReconnect && loaded && (
        <div className="absolute right-2 top-2 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100">
          <ReconnectButton pending={pending} onClick={reconnect} />
        </div>
      )}
    </div>
  );
}

function ReconnectButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs text-white/90 hover:bg-black/75 disabled:opacity-60"
    >
      {pending ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
      {tc("computer.stream.reconnect")}
    </button>
  );
}
