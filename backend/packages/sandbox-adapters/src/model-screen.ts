/**
 * Model screen coordinates: screenshots are scaled down for the model, and the coordinates it clicks with
 * are scaled back up to the framebuffer here. Pure helpers shared by the capture (screen-file) and the
 * pointer commands (screen-diagnostics, the browser `point` check).
 */

/**
 * The size of the screenshots the model sees: a screen is scaled down to fit 1280x800 (WXGA, the size
 * Anthropic's computer-use reference scales to; text stays legible) and never up. 1440x900 becomes 1280x800:
 * about 23% fewer pixels and image tokens per screenshot, and inside every vendor's limit, so no provider
 * resizes it again behind our back (Claude resizes anything over ~1.15 MP, which would shift its clicks).
 * Coordinates the model gives are in this image; `modelToScreenShell` maps them back to the framebuffer.
 */
export const MODEL_SCREEN = { long: 1280, short: 800 } as const;

export function modelScale(width: number, height: number): number {
  return Math.min(1, MODEL_SCREEN.long / Math.max(width, height, 1), MODEL_SCREEN.short / Math.max(1, Math.min(width, height)));
}

/**
 * A shell prefix that sets $1 $2 to the framebuffer point for model coordinates (x, y), with the same
 * scale the screenshot used. It reads the live display size (xdotool getdisplaygeometry, DISPLAY set by
 * the caller), so no screen size is cached anywhere and a restart cannot get it wrong.
 */
export function modelToScreenShell(x: number, y: number): string {
  const px = Number.isFinite(x) ? x : 0;
  const py = Number.isFinite(y) ? y : 0;
  return `set -- $(xdotool getdisplaygeometry | awk -v x=${px} -v y=${py} '{l=($1>$2?$1:$2);m=($1>$2?$2:$1);s=1;if(${MODEL_SCREEN.long}/l<s)s=${MODEL_SCREEN.long}/l;if(${MODEL_SCREEN.short}/m<s)s=${MODEL_SCREEN.short}/m;printf "%d %d",x/s+0.5,y/s+0.5}')`;
}

