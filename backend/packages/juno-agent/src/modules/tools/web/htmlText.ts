/**
 * Readable text from an HTML page for `web_fetch`. No parser dependency: the input is capped first, then the
 * non-content elements are removed with lazy patterns, block tags become line breaks, and entities are decoded.
 * It is a best-effort reader for the model, not a sanitizer: the output is still untrusted page text.
 */

/** Raw HTML beyond this is ignored before any pattern runs, so a huge page cannot make the patterns slow. */
export const HTML_INPUT_CAP = 2_000_000;

/** Dropped to the end of the document when never closed: their text is code or markup, never page content. */
const RUNAWAY_BLOCKS = ['script', 'style', 'noscript', 'template'];
/** Dropped only when closed, because omitting the close tag is legal HTML for these elements' parents. */
const CLOSED_BLOCKS = ['title', 'svg', 'canvas', 'iframe', 'object', 'nav', 'header', 'footer', 'aside', 'button', 'select'];
const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|tr|table|h[1-6]|section|article|main|blockquote|pre|hr|dt|dd|figcaption)\b[^>]*>/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '(c)', mdash: '-', ndash: '-', hellip: '...' };

export interface ReadableText {
  title: string;
  text: string;
  truncated: boolean;
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function removeDropped(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of RUNAWAY_BLOCKS) {
    // An unclosed block drops to the end of the document, so its text never reaches the model.
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'), ' ');
  }
  for (const tag of CLOSED_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  }
  return out;
}

/**
 * Title plus text, cut to `maxChars` at a line boundary when possible. `truncated` is true when text was dropped.
 */
export function extractReadableText(html: string, maxChars: number): ReadableText {
  const capped = html.length > HTML_INPUT_CAP ? html.slice(0, HTML_INPUT_CAP) : html;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(capped);
  const title = titleMatch?.[1] === undefined ? '' : decodeEntities(titleMatch[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  const body = removeDropped(capped).replace(BLOCK_TAGS, '\n').replace(/<[^>]*>/g, ' ');
  const text = decodeEntities(body)
    .replace(/[ \t\f\v\r\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= maxChars) return { title, text, truncated: html.length > HTML_INPUT_CAP };
  const cut = text.slice(0, maxChars);
  const lineEnd = cut.lastIndexOf('\n');
  return { title, text: (lineEnd > maxChars * 0.6 ? cut.slice(0, lineEnd) : cut).trimEnd(), truncated: true };
}
