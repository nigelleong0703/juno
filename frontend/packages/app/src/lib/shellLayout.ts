export const COMPUTER_DEFAULT_WIDTH = 860;
export const COMPUTER_MIN_WIDTH = 420;
export const CHAT_MIN_WIDTH = 280;

/** The chat keeps its floor; the computer minimum relaxes only when it cannot fit. */
export function computerWidthBounds(shellWidth: number, sidebarWidth: number) {
  const max = Math.max(0, shellWidth - sidebarWidth - CHAT_MIN_WIDTH);
  return { min: Math.min(COMPUTER_MIN_WIDTH, max), max };
}

export function clampComputerWidth(preferred: number, bounds: { min: number; max: number }) {
  return Math.min(bounds.max, Math.max(bounds.min, preferred));
}
