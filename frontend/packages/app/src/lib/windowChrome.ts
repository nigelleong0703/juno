/**
 * Shared window-chrome geometry (MC1). One source of truth for the shell header height,
 * the collapsed rail widths, and the native macOS traffic-light position, so the Electron
 * main process, the shell layout, and the tests all read the same numbers.
 *
 * Measured on a 2x Mac screenshot (lead, 2026-10-06): traffic circles run 32..59, 78..105,
 * 124..151 device px, i.e. CSS x16..30, 39..53, 62..76 — three 14px circles with 9px gaps
 * for a 60px group. A 96px native rail leaves equal 18px margins (18 + 60 + 18); position
 * x18 y15 centres the group horizontally and the 14px circles vertically in the 44px
 * header (15 + 7 = 22 = 44 / 2), measured live: the circles render at y15..29. The
 * browser build keeps the 84px rail (no traffic lights); expanded headers are 44px
 * everywhere.
 *
 * Narrow on purpose: plain constants only, no React or platform imports, so Electron main
 * can import it via `@agent-desktop/app/window-chrome` without pulling the app root.
 */

/** One shared header height for the sidebar, conversation, and computer top rows. */
export const SHELL_HEADER_HEIGHT_PX = 44;

/** Collapsed chat-list rail in the browser build (no native traffic lights). */
export const BROWSER_RAIL_WIDTH_PX = 84;

/** Collapsed chat-list rail on native Mac (traffic lights inset into the rail). */
export const NATIVE_MAC_RAIL_WIDTH_PX = 96;

/** Native traffic-light circle diameter (CSS px). */
export const TRAFFIC_LIGHT_DIAMETER_PX = 14;

/** Gap between neighbouring traffic-light circles (CSS px). */
export const TRAFFIC_LIGHT_GAP_PX = 9;

/** Native traffic-light group width: three circles plus two gaps (3*14 + 2*9). */
export const TRAFFIC_GROUP_WIDTH_PX = 60;

/**
 * Native traffic-light position for Electron `hiddenInset` (CSS px from the window's
 * top-left). x18 leaves equal 18px margins around the 60px group in the 96px rail;
 * y15 centres the 14px circles in the 44px header (15 + 7 = 22 = 44 / 2).
 */
export const TRAFFIC_LIGHT_POSITION = { x: 18, y: 15 };

/**
 * The reference app's icon rail, measured on the owner's 2x screenshot (2026-10-17): the rail's
 * background runs x0..51 and the chat list starts at x52, while the top bar's background ends at
 * y44. The rail is therefore 52 wide against a 44 tall bar.
 */
export const REFERENCE_RAIL_WIDTH_PX = 52;

/** Measured native Mac window radius: hiddenInset/fullSizeContentView probe resolves 16pt all corners. */
export const MAC_WINDOW_CORNER_RADIUS_PX = 16;

/**
 * The inset panel that sits beside the icon rail, measured on the reference (owner
 * screenshot 2026-10-17): the chat list's left corners are 12px, and whenever another
 * column takes the chat list's place it carries the same corner.
 */
export const RAIL_PANEL_RADIUS_PX = 12;

/** Actual collapsed rail width for the running platform. */
export function resolveShellRailWidth(hasTrafficLights: boolean): number {
  if (hasTrafficLights) return NATIVE_MAC_RAIL_WIDTH_PX;
  return BROWSER_RAIL_WIDTH_PX;
}

/** Vertical centre of a traffic-light circle (CSS px from the window top). */
export function trafficLightCenterY(): number {
  return TRAFFIC_LIGHT_POSITION.y + TRAFFIC_LIGHT_DIAMETER_PX / 2;
}

/** Vertical centre of the shared header (CSS px from the window top). */
export function shellHeaderCenterY(): number {
  return SHELL_HEADER_HEIGHT_PX / 2;
}
