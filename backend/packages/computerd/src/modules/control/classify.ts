/**
 * What an agent action does to a surface, for the control gateway (BACKEND 7.8b). A look (screenshot, page snapshot, tab list) satisfies
 * the "look first" rule after a hand-back; a mutation (click, type, navigate, a browser write, a desktop act) needs it; anything else
 * (shell, files, processes, spaces, packages) is neither and is not held up by it.
 */
import type { AdmitOptions } from './gateway.js';

export const LOOK: AdmitOptions = { mutation: false, looks: true };
export const MUTATE: AdmitOptions = { mutation: true };

/** Browser actions that only read the page; every other browser action changes it. */
const BROWSER_READS: ReadonlySet<string> = new Set(['snapshot', 'tabs', 'get_text', 'bounds', 'attrs', 'notices']);

export const browserAdmission = (action: string): AdmitOptions => (BROWSER_READS.has(action) ? LOOK : MUTATE);
