// Include the ambient declaration for the noVNC package in every program that
// compiles this file transitively (app, web, desktop): a standalone .d.ts is not
// otherwise part of those programs, and the shipped types only cover the removed
// lib/rfb entry. Resolves to a declaration file, so nothing is emitted at runtime.
import "./novnc.d.ts";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type {
  LiveScreenAdapter,
  LiveScreenStateDetail,
  LiveScreenTarget,
} from "../types";
import { createRfbAdapter, type RfbConstructor } from "./rfb";
import { useFrameSnapshot } from "./useFrameSnapshot";

/**
 * React binding for a noVNC session (§6/§9). Owns the RFB lifecycle for one container element:
 * load the client, connect when a target is known, keep `viewOnly` in sync without reconnecting,
 * and tear the session down cleanly on unmount. The RFB class is injectable so tests can drive
 * the lifecycle with a mock.
 *
 * Handover (GH9/CT3): a rotated ticket (same display, new URL) never destroys the previous
 * session outright. Every session dials into its own full-size, absolutely positioned mount
 * layer, so stacked sessions are overlapping layers — never flex siblings that would each
 * shrink to half the frame — and a retained socket's own resize can only touch its own layer.
 * The fresh layer stays hidden until its canvas has actually painted pixels, not merely
 * completed the protocol handshake; only then does it replace the held frame. A bounded paint
 * failure keeps the held frame on screen and reports a truthful retry instead of revealing a
 * blank "connected" frame.
 */

let realRfbPromise: Promise<RfbConstructor> | null = null;

/** Lazily import `@novnc/novnc` once per session (it is a large ESM module). */
export function loadRealRfb(): Promise<RfbConstructor> {
  // Literal specifier so Vite can statically analyze and bundle `@novnc/novnc`
  // (package exports `./core/rfb.js`) instead of leaving a bare specifier for the
  // browser to resolve. Types come from the local `novnc.d.ts` ambient declaration
  // because `@types/novnc__novnc` only targets the old `lib/rfb` path.
  realRfbPromise ??= import("@novnc/novnc").then((mod) => mod.default);
  return realRfbPromise;
}

export interface UseRfbOptions {
  /** Element the per-session noVNC layers mount into. */
  containerRef: RefObject<HTMLElement | null>;
  /** Websocket target; connect only happens once this is non-null. */
  target?: LiveScreenTarget | null;
  /** Watch (true) vs control (false). Toggling does not reconnect. */
  viewOnly?: boolean;
  /** Set false to stay disconnected without removing the target. */
  enabled?: boolean;
  /** Injected RFB constructor (tests); defaults to the real `@novnc/novnc`. */
  createRfb?: RfbConstructor;
  /**
   * Paint probe for the fresh session canvas. Defaults to sampling canvas alpha
   * (public pixels only, never RFB internals); tests inject a scripted stub.
   */
  isFramePainted?: (canvas: HTMLCanvasElement) => boolean;
  /**
   * Bounded time a handshake-only session may sit unpainted before the surface reports a
   * truthful retry instead of a blank "connected" frame. Injectable so tests need not wait
   * the real three seconds.
   */
  paintTimeoutMs?: number;
  /** The remote computer's clipboard text after a `copy()`. */
  onClipboard?: (text: string) => void;
}

export interface UseRfbResult {
  state: LiveScreenStateDetail;
  /** True once the current session has drawn real pixels — paint, not the handshake. */
  painted: boolean;
  setViewOnly(viewOnly: boolean): void;
  reconnect(): void;
  /** Ctrl+C on the remote; the text comes back through `onClipboard`. */
  copy(): void;
  paste(text: string): void;
  /** Ctrl+V on the remote alone (the remote clipboard was filled by the side channel). */
  pressPaste(): void;
}

/** How long a fresh session may take to paint before the surface reports a truthful retry. */
const PAINT_TIMEOUT_MS = 3000;
/** Message shown when a session completes the handshake but never paints. */
const PAINT_FAILURE_MESSAGE = "The screen connected but never started painting.";

/**
 * Public-pixel paint probe: true once any sampled pixel is opaque. Canvas APIs
 * only — no RFB internals. Environments without a 2d context (jsdom) cannot
 * sample, so they report painted and fall back to connect-time handover; real
 * browsers always sample and gate on actual paint. A zero-size canvas (noVNC's
 * unready placeholder) is never painted, so its intrinsic size is never adopted.
 */
export function frameCanvasPainted(canvas: HTMLCanvasElement): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  let context: CanvasRenderingContext2D | null;
  try {
    context = canvas.getContext("2d", { willReadFrequently: true });
  } catch {
    return true;
  }
  if (!context) return true;
  try {
    const width = canvas.width;
    const height = canvas.height;
    const xs = [0, width - 1, width >> 1, width / 3, (width * 2) / 3];
    const ys = [0, height - 1, height >> 1, height / 3, (height * 2) / 3];
    for (let i = 0; i < xs.length; i += 1) {
      const x = Math.max(0, Math.min(width - 1, Math.floor(xs[i] ?? 0)));
      const y = Math.max(0, Math.min(height - 1, Math.floor(ys[i] ?? 0)));
      if (context.getImageData(x, y, 1, 1).data[3] !== 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** One dialed noVNC session: its own full-size mount layer plus the adapter over it. */
interface RfbSession {
  adapter: LiveScreenAdapter;
  layer: HTMLDivElement;
  unsubscribe: () => void;
  /** True once the session is torn down; late adapter events are then ignored. */
  released: boolean;
  /**
   * The session's framebuffer canvas, remembered at paint time. noVNC removes its canvas from
   * the DOM before it emits a disconnect, so holding the element is the only way to freeze the
   * last painted pixels once a server-side revocation tears the socket down.
   */
  canvas: HTMLCanvasElement | null;
}

export function useRfb({
  containerRef,
  target,
  viewOnly = true,
  enabled = true,
  createRfb,
  isFramePainted,
  paintTimeoutMs = PAINT_TIMEOUT_MS,
  onClipboard,
}: UseRfbOptions): UseRfbResult {
  const [state, setState] = useState<LiveScreenStateDetail>({ state: "idle" });
  const [painted, setPainted] = useState(false);
  const [paintFailure, setPaintFailure] = useState<string | null>(null);
  // Lazy initializer: a bare `createRfb` is a class, which `useState` would otherwise *call*.
  const [ctor, setCtor] = useState<RfbConstructor | null>(() => createRfb ?? null);
  const [attempt, setAttempt] = useState(0);

  // The session being dialed/showed by the current effect run, and the session whose pixels
  // are currently on screen (kept across a rotation until the fresh one paints).
  const activeRef = useRef<RfbSession | null>(null);
  const shownRef = useRef<RfbSession | null>(null);
  const paintTimerRef = useRef<number | null>(null);
  const onClipboardRef = useRef(onClipboard);
  onClipboardRef.current = onClipboard;

  // Resolve the RFB constructor (injected or the real client) before connecting.
  useEffect(() => {
    if (ctor || !enabled || createRfb) return;
    let cancelled = false;
    loadRealRfb()
      .then((loaded) => {
        // `loaded` is a class (a function): a bare `setCtor(loaded)` would be taken as an updater
        // and invoked with the previous state, so wrap it in a thunk to store the constructor.
        if (!cancelled) setCtor(() => loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          state: "error",
          message: error instanceof Error ? error.message : "Failed to load the VNC client",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ctor, enabled, createRfb]);

  const url = target?.url;
  const password = target?.password;

  // Keep the latest viewOnly in a ref so toggling it never re-runs the connect effect.
  const viewOnlyRef = useRef(viewOnly);
  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    activeRef.current?.adapter.setViewOnly(viewOnly);
  }, [viewOnly]);

  const paintProbeRef = useRef(isFramePainted ?? frameCanvasPainted);
  useEffect(() => {
    paintProbeRef.current = isFramePainted ?? frameCanvasPainted;
  }, [isFramePainted]);

  const stopPaintWatch = useCallback(() => {
    if (paintTimerRef.current !== null) {
      window.clearInterval(paintTimerRef.current);
      paintTimerRef.current = null;
    }
  }, []);

  const releaseSession = useCallback((session: RfbSession) => {
    if (session.released) return;
    session.released = true;
    // Detach before disconnecting so the teardown's own `disconnect` event can never
    // wake React with a stale state after the session is gone.
    session.unsubscribe();
    session.adapter.disconnect();
    session.layer.remove();
  }, []);

  // One static last-frame layer for this surface (see useFrameSnapshot): a screen switch remounts
  // the surface and a fresh paint clears it, so it never carries another display's pixels.
  const { freeze, clear: clearSnapshot } = useFrameSnapshot(containerRef);

  const showSession = useCallback(
    (session: RfbSession) => {
      session.layer.style.visibility = "visible";
      const previous = shownRef.current;
      if (previous && previous !== session) releaseSession(previous);
      shownRef.current = session;
      // Fresh pixels supersede the frozen frame: same screen, one tick newer.
      clearSnapshot();
      setPainted(true);
    },
    [releaseSession, clearSnapshot],
  );

  const failPaint = useCallback(
    (session: RfbSession) => {
      stopPaintWatch();
      // Nothing painted, so the fresh layer is discarded; the previously displayed
      // frame stays mounted (kept by the rotation cleanup) under the retry overlay.
      releaseSession(session);
      setPaintFailure(PAINT_FAILURE_MESSAGE);
    },
    [releaseSession, stopPaintWatch],
  );

  // Handshake is not paint: only a canvas that actually draws hands the frame over.
  const watchFreshPaint = useCallback(
    (session: RfbSession) => {
      stopPaintWatch();
      const canvas = session.layer.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement)) {
        // No canvas to sample (jsdom, embedders): trust the handshake and hand over.
        showSession(session);
        return;
      }
      if (paintProbeRef.current(canvas)) {
        session.canvas = canvas;
        showSession(session);
        return;
      }
      const deadline = Date.now() + paintTimeoutMs;
      paintTimerRef.current = window.setInterval(() => {
        if (!canvas.isConnected) {
          stopPaintWatch();
          return;
        }
        if (paintProbeRef.current(canvas)) {
          stopPaintWatch();
          session.canvas = canvas;
          showSession(session);
          return;
        }
        if (Date.now() > deadline) failPaint(session);
      }, 100);
    },
    [failPaint, paintTimeoutMs, showSession, stopPaintWatch],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || !url || !ctor) return;

    // Each session dials into its own full-size absolute layer. Stacked sessions are
    // overlapping layers, so a rotated ticket never makes the held frame a flex sibling
    // that shrinks, and the retained socket can only restyle its own layer. The layer
    // stays hidden until its canvas paints.
    const layer = document.createElement("div");
    layer.dataset.rfbLayer = "session";
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.width = "100%";
    layer.style.height = "100%";
    layer.style.visibility = "hidden";
    container.appendChild(layer);

    const adapter = createRfbAdapter({ createRfb: ctor, container: layer });
    const session: RfbSession = {
      adapter,
      layer,
      unsubscribe: () => {},
      released: false,
      canvas: null,
    };

    setPaintFailure(null);
    setPainted(false);

    adapter.onClipboard((text) => onClipboardRef.current?.(text));
    session.unsubscribe = adapter.onState((detail) => {
      if (session.released) return;
      setPaintFailure(null);
      setState(detail);
      if (detail.state === "connected") {
        watchFreshPaint(session);
        return;
      }
      // An error or disconnect must cancel a pending paint watch: a stale timer could
      // otherwise later report a failure for a session that already told us it is gone.
      stopPaintWatch();
      if (detail.state === "disconnected" && shownRef.current === session) {
        // A shown stream can die without our asking: on return-control the server revokes the
        // writable socket and noVNC tears the canvas out of the DOM *before* this event. Freeze
        // the last painted pixels synchronously — the detached canvas still holds them right
        // now, but the revoked buffer may be blanked on a later tick — then drop the dead
        // session so the rotation cleanup cannot mistake it for a live hold.
        freeze(session.canvas);
        if (activeRef.current === session) activeRef.current = null;
        shownRef.current = null;
        releaseSession(session);
      }
    });

    activeRef.current = session;
    adapter.connect({ url, password }, { viewOnly: viewOnlyRef.current });

    return () => {
      stopPaintWatch();
      if (activeRef.current === session) activeRef.current = null;
      if (shownRef.current === session) {
        // Rotation, not teardown. Freeze what is on screen right now — the canvas still holds
        // these pixels — so a revocation that lands *after* this cleanup (the event then has no
        // handler, since we unsubscribe below) still leaves the last frame saved. If a
        // disconnect already retired this session, shownRef is null and this guard keeps that
        // snapshot instead of overwriting it. The socket stays on screen, read-only, until the
        // fresh session paints or the bounded fallback reports.
        freeze(session.canvas);
        session.unsubscribe();
        session.adapter.setViewOnly(true);
        return;
      }
      releaseSession(session);
    };
  }, [enabled, containerRef, url, password, ctor, attempt, watchFreshPaint, stopPaintWatch, releaseSession, freeze]);

  // Disabling drops everything: no parked frame or socket may outlive an inactive surface.
  useEffect(() => {
    if (enabled) return;
    const shown = shownRef.current;
    const active = activeRef.current;
    shownRef.current = null;
    activeRef.current = null;
    if (shown) releaseSession(shown);
    if (active) releaseSession(active);
    clearSnapshot();
    setPainted(false);
    setPaintFailure(null);
  }, [enabled, releaseSession, clearSnapshot]);

  // Unmount must also destroy a parked frame the rotation cleanup deliberately kept.
  useEffect(
    () => () => {
      const shown = shownRef.current;
      const active = activeRef.current;
      shownRef.current = null;
      activeRef.current = null;
      if (shown) releaseSession(shown);
      if (active) releaseSession(active);
    },
    [releaseSession],
  );

  const setViewOnly = useCallback((next: boolean) => {
    activeRef.current?.adapter.setViewOnly(next);
  }, []);

  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  const copy = useCallback(() => activeRef.current?.adapter.copy(), []);
  const paste = useCallback((text: string) => activeRef.current?.adapter.paste(text), []);
  const pressPaste = useCallback(() => activeRef.current?.adapter.pressPaste(), []);

  // A handshake that never paints is reported as a truthful error (with retry), never a
  // silent "connected" blank; the held frame stays visible behind the overlay.
  const effectiveState: LiveScreenStateDetail =
    paintFailure !== null && state.state === "connected"
      ? { state: "error", message: paintFailure }
      : state;

  return { state: effectiveState, painted, setViewOnly, reconnect, copy, paste, pressPaste };
}
