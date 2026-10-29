import type { CSSProperties } from "react";

/**
 * Surface styling for the Computer pane (E2). The owner asked for a big rounded live screen: 24px
 * on the frame so it reads as one dominant rounded surface, 14–16px on cards/popovers, pill
 * buttons/chips. Electron additionally smooths rounded corners with `-electron-corner-smoothing`;
 * the property is ignored by browsers, so the same style object is safe on the web build.
 */
export const SCREEN_RADIUS = 24;
export const CARD_RADIUS = 16;
export const POPOVER_RADIUS = 14;

/** Inline style carrying a radius plus Electron's corner smoothing. */
export function roundedSurface(radius: number, extra?: CSSProperties): CSSProperties {
  return {
    borderRadius: radius,
    ["-electron-corner-smoothing"]: "60%",
    ...extra,
  } as CSSProperties;
}

/** Tailwind class for a pill (fully rounded) control. */
export const PILL = "rounded-full";
