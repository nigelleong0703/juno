/**
 * Which screen actions may be repeated once after the computer link broke mid-call (BACKEND §7.11, fault tolerance).
 * Only pure reads qualify: anything that could already have changed the computer (clicks, typing, shell, writes, processes)
 * is never replayed, because the first attempt may have reached it.
 */
import type { ScreenAction } from './types.js';

const READ_ONLY_BROWSER = new Set(['tabs', 'snapshot', 'get_text', 'bounds', 'attrs', 'notices', 'point']);

export function isIdempotentAction(action: ScreenAction): boolean {
  switch (action.kind) {
    case 'screenshot':
    case 'readFile':
    case 'readProcess':
      return true;
    case 'browser':
      return READ_ONLY_BROWSER.has(action.input.action);
    default:
      return false;
  }
}
