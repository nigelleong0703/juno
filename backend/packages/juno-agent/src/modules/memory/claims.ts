/**
 * The claim tag on a line of a view (BACKEND §5.4). A line that came through the hourly job ends with `[claim:<id>]`; `memory_explain`
 * finds the claim behind a line by it. The views themselves are rendered from the items (views.ts).
 */

const TAG = /\s*\[claim:([A-Za-z0-9_-]+)\]\s*$/;

export const claimTag = (id: string): string => '[claim:' + id + ']';

/** The claim id a line ends with, or undefined when the line has none. */
export const claimIdOfLine = (line: string): string | undefined => TAG.exec(line)?.[1];
