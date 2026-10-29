/**
 * The marked-up topic summary (BACKEND §5.4): the nightly job writes the summary with `[[<item id>|<phrase>]]` around each phrase that
 * states an item, and the Memory page shows every such phrase as a tappable link to that item. The marker is stored as written (after
 * `cleanMarkup`); `segmentsOf` turns it into the pieces the app renders. A marker that is nested, unclosed, empty or names an id that
 * is not allowed is plain text: the phrase stays, the link goes.
 */

/** One piece of a summary: plain text, or a phrase that opens the memory item `itemId`. */
export interface TopicSegment {
  text: string;
  itemId?: string;
}

/** A marker whose phrase holds no brackets: a nested or unclosed one leaves its outer brackets unmatched, and those are dropped as text. */
const MARKER = /\[\[([^[\]|]+)\|([^[\]]*)\]\]/g;

/** Splits marked-up text into segments. `isKnown` says which ids may link; any other marker keeps its phrase as plain text. */
export function segmentsOf(markup: string, isKnown: (itemId: string) => boolean): TopicSegment[] {
  const segments: TopicSegment[] = [];
  const push = (text: string, itemId?: string) => {
    if (text === '') return;
    const last = segments[segments.length - 1];
    if (itemId === undefined && last !== undefined && last.itemId === undefined) last.text += text;
    else segments.push(itemId === undefined ? { text } : { text, itemId });
  };
  // Text between markers: a stray opener (with its id, if it has one) or closer is dropped.
  const plain = (text: string) => text.replace(/\[\[(?:[^[\]|]*\|)?|\]\]/g, '');
  let at = 0;
  for (const match of markup.matchAll(MARKER)) {
    push(plain(markup.slice(at, match.index)));
    const id = (match[1] ?? '').trim();
    const phrase = plain(match[2] ?? '');
    push(phrase, phrase.trim() !== '' && isKnown(id) ? id : undefined);
    at = match.index + match[0].length;
  }
  push(plain(markup.slice(at)));
  return segments;
}

/** Segments back to marked-up text. */
export function markupOf(segments: readonly TopicSegment[]): string {
  return segments.map((segment) => (segment.itemId === undefined ? segment.text : '[[' + segment.itemId + '|' + segment.text + ']]')).join('');
}

/** The summary as plain text, without the markers. */
export function plainOf(markup: string): string {
  return segmentsOf(markup, () => false).map((segment) => segment.text).join('');
}

/**
 * What the nightly job stores: whitespace collapsed, markers with an id outside `allowed` turned into plain text, stray brackets
 * dropped, and the readable text cut to `maxChars` (never in the middle of a marker).
 */
export function cleanMarkup(raw: string, allowed: ReadonlySet<string>, maxChars: number): string {
  let left = maxChars;
  const kept: TopicSegment[] = [];
  for (const segment of segmentsOf(raw.replace(/\s+/g, ' '), (id) => allowed.has(id))) {
    if (left <= 0) break;
    kept.push(segment.text.length <= left ? segment : { ...segment, text: segment.text.slice(0, left) });
    left -= segment.text.length;
  }
  return markupOf(kept).trim();
}
