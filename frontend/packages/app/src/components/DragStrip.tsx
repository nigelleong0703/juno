import { dragRegion } from "../lib/drag";

/**
 * The window's drag handle: one `--shell-header-height` strip along the top edge, first in its screen so every
 * control after it overrides it (see app.css for the control carve-out). Used by the shell and by the screens that
 * render before it (connect server, sign in, model gate). Callers render it only on desktop; it is a no-op on web.
 */
export function DragStrip() {
  return <div style={dragRegion} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[var(--shell-header-height)]" />;
}
