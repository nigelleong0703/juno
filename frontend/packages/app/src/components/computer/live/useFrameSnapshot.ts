import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * A static "last painted frame" layer for the live screen.
 *
 * On return-control the server revokes the writable websocket, and noVNC removes its canvas from
 * the DOM before it emits a disconnect, so the frame the user last saw would otherwise vanish.
 * This layer holds a copy of the shown canvas's pixels, frozen synchronously at disconnect time —
 * before a revoked buffer can be blanked — and independent of any socket. It carries one
 * display's pixels only: the surface remounts on a screen switch, and a fresh paint clears it.
 */

/** Dataset key marking the layer, so the framebuffer-size observer can skip it. */
export const FRAME_SNAPSHOT_LAYER_ATTR = "rfbSnapshot";

export interface FrameSnapshotHandle {
  /** Copy the current pixels of `source` into the layer and reveal it; a no-op without pixels. */
  freeze(source: HTMLCanvasElement | null): void;
  /** Hide and empty the layer: a fresh frame has superseded it. */
  clear(): void;
}

const LAYER_VALUE = "last-frame";

/** Mount one frozen-frame layer into `containerRef` and return the freeze/clear controls. */
export function useFrameSnapshot(containerRef: RefObject<HTMLElement | null>): FrameSnapshotHandle {
  const layerRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const layer = document.createElement("canvas");
    layer.dataset[FRAME_SNAPSHOT_LAYER_ATTR] = LAYER_VALUE;
    layer.setAttribute("aria-hidden", "true");
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.width = "100%";
    layer.style.height = "100%";
    layer.style.visibility = "hidden";
    layer.style.pointerEvents = "none";
    // Stay 0x0 until a frame is frozen: a floor-sized canvas would be adopted by the
    // framebuffer-size observer (and read as painted wherever 2d sampling is unavailable).
    layer.width = 0;
    layer.height = 0;
    container.appendChild(layer);
    layerRef.current = layer;
    return () => {
      layer.remove();
      if (layerRef.current === layer) layerRef.current = null;
    };
  }, [containerRef]);

  const freeze = useCallback((source: HTMLCanvasElement | null) => {
    const layer = layerRef.current;
    if (!layer || !source || source.width <= 0 || source.height <= 0) return;
    const context = layer.getContext("2d");
    if (!context) return;
    try {
      layer.width = source.width;
      layer.height = source.height;
      context.clearRect(0, 0, layer.width, layer.height);
      context.drawImage(source, 0, 0);
      layer.style.visibility = "visible";
    } catch {
      // A tainted source cannot be sampled; keep the last frozen frame rather than a blank.
    }
  }, []);

  const clear = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.style.visibility = "hidden";
    layer.width = 0;
    layer.height = 0;
  }, []);

  return { freeze, clear };
}

