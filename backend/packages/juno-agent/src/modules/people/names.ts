/**
 * Names as people write them, for matching a name to a person or an account (BACKEND §9.5, §9.6): no case, no curly quotes, no zero-width
 * characters, single spaces, and no possessive ("Priya's" is Priya). `displayName` keeps the case and is what a new person is called.
 * The invisible and curly characters are named by code point, so this file holds no literal ones.
 */

/** Zero-width space, zero-width non-joiner and joiner, word joiner, byte order mark: removed from names, one code point at a time. */
const INVISIBLE: readonly string[] = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((code) => String.fromCharCode(code));
/** Curly single quotes and the modifier letter apostrophe: all read as a plain apostrophe. */
const APOSTROPHES = new RegExp('[' + String.fromCharCode(0x2018, 0x2019, 0x02bc) + '`]', 'g');
/** Curly double quotes and the straight one: dropped from names. */
const QUOTES = new RegExp('[' + String.fromCharCode(0x201c, 0x201d) + '"]', 'g');

/** The name cleaned for display: Unicode-normalised, the apostrophe plain, invisible characters and quote marks removed, a possessive dropped. */
export function displayName(value: string): string {
  const visible = INVISIBLE.reduce((text, invisible) => text.split(invisible).join(''), value.normalize('NFKC'));
  return visible
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/'s$/i, '')
    .trim();
}

/** The key two names are compared by: the display name, lower-cased. */
export const nameKey = (value: string): string => displayName(value).toLowerCase();
