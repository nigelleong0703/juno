/**
 * The Feed article's inline pictures as data (BACKEND feed-article): what `feed_post` verifies before
 * publishing and what the API rewrites to signed cached URLs on the way out. One synchronous parser,
 * no custom regex dialect, so both sides share it instead of keeping two copies that drift apart.
 *
 * Discovery runs on a proven CommonMark parser (`mdast-util-from-markdown`): the same constructs the
 * client's renderer loads are the ones found here, including reference definitions split across lines
 * with an indented destination. A hand scanner kept missing those renderer-loadable forms, so node
 * discovery is never hand-rolled. Only the destination sub-range inside a parser-confirmed node is
 * located locally (balanced brackets, titles, escapes), because tree nodes report whole-syntax ranges
 * while the rewrite must splice the destination token only.
 *
 * Supported authoring syntax: inline `![alt](url)` and reference (`![alt][ref]` with `[ref]: url`
 * defined in the same body, plus the collapsed (`![alt][]`) and shortcut (`![alt]`) reference forms.
 * Fenced code, indented code, and inline code spans are examples, never pictures: the parser leaves
 * them as code nodes, so anything image-like inside them is skipped exactly as the client renders it.
 * HTML `<img>` tags are neither rendered nor verified; `containsHtmlImage` reports them so the caller
 * can ask for Markdown instead.
 *
 * Shared API (re-exported for the API media builder via `@agent-desktop/contracts/net`):
 * - `extractMarkdownImageRefs(body)` lists every rendered image's destination with its source range.
 *   The `url` is the parser's decoded destination (the form that is verified and fetched); the range
 *   covers the raw token so the rewrite replaces the encoded form whole.
 * - `rewriteMarkdownImageUrls(body, mapper)` splices each destination through `mapper` (which returns
 *   the replacement URL, or `undefined` to keep the original); ranges are applied back to front so
 *   offsets stay valid, and each definition is rewritten once no matter how often it is referenced.
 * - `containsHtmlImage(body)` reports an `<img>` tag, which neither side supports.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Definition, Image, Nodes, Root } from 'mdast';

export interface MarkdownImageRef {
  /** The destination URL, decoded (without surrounding `< >`). */
  url: string;
  /** Offset of the destination token in `body` (including `< >` when the author used them). */
  start: number;
  /** Offset just past the destination token. */
  end: number;
}

/** Reference identifiers match case-insensitively with collapsed whitespace. */
function normLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

interface Offsets { start: number; end: number }

/** The source range of a node; the parser always positions the nodes this module reads. */
function offsetsOf(node: { position?: { start: { offset?: number | null }; end: { offset?: number | null } } | null | undefined }): Offsets | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

/** Depth-first visit of a tree. */
function eachNode(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ('children' in node) {
    for (const child of node.children) eachNode(child, visit);
  }
}

/** The next `]` closing the bracket opened at `open`, honouring nesting and escapes. */
function closeBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** An unescaped closer: the character is literal when preceded by an odd run of backslashes. */
function isEscaped(text: string, pos: number): boolean {
  let slashes = 0;
  for (let i = pos - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

/**
 * Skip separators between syntax parts: blanks, line breaks, and the container line prefixes
 * (blockquote `>`, indentation) a multiline definition or image use may cross. A `>` only counts
 * as a prefix when the line holds nothing else, so literal `>` text is never skipped.
 */
function skipGap(raw: string, i: number): number {
  for (;;) {
    while (raw[i] === ' ' || raw[i] === '\t') i++;
    if (raw[i] === '\n' || raw[i] === '\r') { i++; continue; }
    if (raw[i] === '>') {
      let back = i - 1;
      while (back >= 0 && (raw[back] === ' ' || raw[back] === '\t' || raw[back] === '>')) back--;
      if (back < 0 || raw[back] === '\n' || raw[back] === '\r') { i++; continue; }
    }
    return i;
  }
}

/**
 * The destination token after an opening marker: `<...>` (escape-aware) or a bare token with
 * balanced parens and backslash escapes. Returns absolute offsets, or null on malformed input.
 */
function destToken(raw: string, base: number, from: number, endOk: boolean): Offsets | null {
  let i = skipGap(raw, from);
  if (raw[i] === '<') {
    const start = base + i;
    i++;
    while (i < raw.length && (raw[i] !== '>' || isEscaped(raw, i))) i++;
    if (i >= raw.length) return null;
    return { start, end: base + i + 1 };
  }
  const start = base + i;
  let depth = 0;
  while (i < raw.length && (depth > 0 || (!isSpace(raw[i]) && (raw[i] !== ')' || isEscaped(raw, i))))) {
    if (raw[i] === '\\') { i += 2; continue; }
    if (raw[i] === '(') depth++;
    else if (raw[i] === ')') depth--;
    i++;
  }
  if (base + i === start || (i >= raw.length && !endOk)) return null;
  return { start, end: base + i };
}

/** Skip leading whitespace the node's range may include before the syntax. */
function trimBase(raw: string, base: number): { raw: string; base: number } {
  let skip = 0;
  while (isSpace(raw[skip])) skip++;
  return { raw: raw.slice(skip), base: base + skip };
}

/** Destination range of a parser-confirmed inline image (`![alt](dest [title])`). */
function inlineDestRange(raw: string, base: number): Offsets | null {
  ({ raw, base } = trimBase(raw, base));
  const altEnd = closeBracket(raw, 1);
  if (altEnd < 0 || raw[altEnd + 1] !== '(') return null;
  return destToken(raw, base, altEnd + 2, false);
}

/** Destination range of a parser-confirmed link definition (`[label]: dest [title]`). */
function definitionDestRange(raw: string, base: number): Offsets | null {
  ({ raw, base } = trimBase(raw, base));
  const labelEnd = closeBracket(raw, 0);
  if (labelEnd < 0 || raw[labelEnd + 1] !== ':') return null;
  return destToken(raw, base, labelEnd + 2, true);
}

function recordDefinition(node: Definition, body: string, definitions: Map<string, MarkdownImageRef>): void {
  const key = normLabel(node.identifier);
  if (definitions.has(key)) return;
  const pos = offsetsOf(node);
  if (pos === null) return;
  const dest = definitionDestRange(body.slice(pos.start, pos.end), pos.start);
  if (dest === null) return;
  definitions.set(key, { url: node.url, start: dest.start, end: dest.end });
}

function recordInline(node: Image, body: string, refs: MarkdownImageRef[]): void {
  const pos = offsetsOf(node);
  if (pos === null) return;
  const dest = inlineDestRange(body.slice(pos.start, pos.end), pos.start);
  if (dest === null) return;
  refs.push({ url: node.url, start: dest.start, end: dest.end });
}

/** Every rendered image destination with its source range, in body order. */
export function extractMarkdownImageRefs(body: string): MarkdownImageRef[] {
  const tree: Root = fromMarkdown(body);
  const definitions = new Map<string, MarkdownImageRef>();
  const refs: MarkdownImageRef[] = [];
  const seenStarts = new Set<number>();
  const emit = (ref: MarkdownImageRef): void => {
    if (!seenStarts.has(ref.start)) {
      seenStarts.add(ref.start);
      refs.push(ref);
    }
  };
  const pending: string[] = [];
  eachNode(tree, (node) => {
    if (node.type === 'definition') recordDefinition(node, body, definitions);
    else if (node.type === 'image') recordInline(node, body, refs);
    else if (node.type === 'imageReference') pending.push(normLabel(node.identifier));
  });
  for (const key of pending) {
    const def = definitions.get(key);
    if (def !== undefined) emit(def);
  }
  return refs.sort((a, b) => a.start - b.start);
}

/** Rewrite each image destination through `mapper` (`undefined` keeps the original). */
export function rewriteMarkdownImageUrls(body: string, mapper: (url: string) => string | undefined): string {
  const refs = extractMarkdownImageRefs(body).sort((a, b) => b.start - a.start);
  let out = body;
  for (const ref of refs) {
    const replacement = mapper(ref.url);
    if (replacement !== undefined) out = out.slice(0, ref.start) + replacement + out.slice(ref.end);
  }
  return out;
}

/** An HTML `<img>` tag: neither rendered nor verified, so the caller must refuse it. */
export function containsHtmlImage(body: string): boolean {
  const tree: Root = fromMarkdown(body);
  let found = false;
  eachNode(tree, (node) => {
    if (!found && node.type === 'html' && /<img(?=[\s/>])/i.test(node.value)) found = true;
  });
  return found;
}
