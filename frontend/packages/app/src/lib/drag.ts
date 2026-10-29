import type { CSSProperties } from "react";

/**
 * Electron drag regions (ARCHITECTURE §9). `packages/app` never imports Electron; these two
 * style objects are plain CSS that only the desktop shell acts on (`-webkit-app-region`). They
 * are no-ops in the browser build.
 *
 * They live in `lib/` because the shell *and* the conversation surfaces both paint title rows: a
 * generic DOM concern shared across layers must not force content components to import `shell/`.
 */
type DragStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };

export const dragRegion: DragStyle = { WebkitAppRegion: "drag" };
export const noDragRegion: DragStyle = { WebkitAppRegion: "no-drag" };
