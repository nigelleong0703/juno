import type { Page } from './core.mjs';
/** Types for the unchanged upstream handoff formatter. */
export function formatPage(page: Page, options?: { maxElements?: number; interactive?: boolean; filter?: string; urls?: boolean; maxChars?: number }): string;
