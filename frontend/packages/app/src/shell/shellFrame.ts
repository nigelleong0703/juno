/** Sidebar width bounds in px (owner feedback: sizes are pixels, 240-400). */
export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 400;

/** Next animation frame with a timer fallback (engines without rAF still retarget). */
export function nextFrame(callback: () => void): number {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 16);
}

export function cancelFrame(frame: number): void {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frame);
    return;
  }
  window.clearTimeout(frame);
}
