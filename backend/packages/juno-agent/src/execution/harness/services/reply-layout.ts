/**
 * How a run's final reply text becomes chat bubbles.
 *
 * Each blank-line-separated paragraph is its own bubble (the way people text), except where splitting would
 * break the sense: a lead-in line ending with ":" stays with what it introduces, consecutive lists stay
 * together, a code fence stays whole, and a document (heading or table) is one bubble. A fenced block with the
 * info string `card` holds one UiDoc JSON object; a valid card is attached to the bubble right before it, a
 * broken one is reported in `cardErrors` and dropped. Pure: the same text always yields the same layout.
 */
import { parseUiDoc, uiDocToText, type UiDoc } from '@agent-desktop/public-contracts';

export interface ReplyBubble { markdown: string; ui?: UiDoc }
export interface ReplyLayout { bubbles: ReplyBubble[]; cardErrors: string[] }

/** Past this many bubbles the reply is posted unsplit (one bubble per text segment); nothing is dropped. */
export const MAX_REPLY_BUBBLES = 6;

type Part = { kind: 'text'; text: string } | { kind: 'card'; body: string; closed: boolean };

const CARD_OPEN = /^```card[ \t]*$/;
const CARD_CLOSE = /^```[ \t]*$/;
const DOCUMENT = /^#{1,6}\s|^\s*\|.*\|\s*$/m;
const LIST_LINE = /^\s*([-*•]|\d+[.)])\s/;
const BLANK = /^[ \t]*$/;

/** Cut the text into plain segments and card blocks. */
function splitCards(text: string): Part[] {
  const parts: Part[] = [];
  let plain: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!CARD_OPEN.test(lines[i] ?? '')) {
      plain.push(lines[i] ?? '');
      continue;
    }
    parts.push({ kind: 'text', text: plain.join('\n') });
    plain = [];
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !CARD_CLOSE.test(lines[i] ?? '')) {
      body.push(lines[i] ?? '');
      i += 1;
    }
    parts.push({ kind: 'card', body: body.join('\n'), closed: i < lines.length });
  }
  parts.push({ kind: 'text', text: plain.join('\n') });
  return parts;
}

/** Paragraphs of a segment: blank lines separate them, except inside a code fence. */
function paragraphs(segment: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of segment.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && BLANK.test(line)) {
      out.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  out.push(current.join('\n'));
  return out.map((block) => block.trim()).filter((block) => block.length > 0);
}

const isList = (block: string): boolean => block.split('\n').filter((line) => line.trim().length > 0).every((line) => LIST_LINE.test(line));

/** A paragraph stays in the previous bubble: after a lead-in ending ":" and between two list paragraphs. */
function joinsPrevious(previous: string, block: string): boolean {
  return previous.endsWith(':') || (isList(previous) && isList(block));
}

/** Group paragraphs into bubbles. Joins compare against the previous paragraph as written, not the merged bubble. */
function groupParagraphs(blocks: string[]): string[] {
  const out: string[] = [];
  let previous: string | undefined;
  for (const block of blocks) {
    if (previous !== undefined && joinsPrevious(previous, block)) out[out.length - 1] = `${out[out.length - 1]}\n\n${block}`;
    else out.push(block);
    previous = block;
  }
  return out;
}

/** The bubbles one text segment makes. */
function segmentBubbles(segment: string, split: boolean): string[] {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return [];
  if (!split || DOCUMENT.test(trimmed)) return [trimmed];
  return groupParagraphs(paragraphs(trimmed));
}

/** True when the text stops after a blank line outside any code fence: the last paragraph is finished. */
function endsAfterBlankLine(text: string): boolean {
  const fences = text.split('\n').filter((line) => /^\s*```/.test(line)).length;
  return fences % 2 === 0 && /\n[ \t]*\n[ \t]*$/.test(text);
}

/**
 * The bubbles of a reply that is still being written which are certain to stay as they are, the same
 * grouping layoutReply uses: a paragraph still being written, a lead-in ending ":" and a list that may
 * continue wait for what follows; nothing is released inside a code fence, past a card, or in a document
 * (heading or table). The text of a released bubble never changes as more text arrives.
 */
export function closedBlocks(text: string): string[] {
  const lines = text.split('\n');
  const card = lines.findIndex((line) => CARD_OPEN.test(line));
  const head = card < 0 ? text : lines.slice(0, card).join('\n');
  if (DOCUMENT.test(head)) return [];
  const all = paragraphs(head);
  // Before a card, or without a blank line after it, the last paragraph is still open (a card attaches to it).
  const finished = card < 0 && endsAfterBlankLine(head);
  const open = finished ? undefined : all[all.length - 1];
  const done = finished ? all : all.slice(0, -1);
  const groups = groupParagraphs(done);
  const tail = done[done.length - 1];
  if (tail === undefined) return [];
  // The last group is closed when nothing can join it: not a lead-in, and a list only if what follows is not one
  // (a few characters could still become a list marker).
  const joinable = tail.endsWith(':') || (isList(tail) && (open === undefined || (open.length < 4 && !open.includes('\n')) || LIST_LINE.test(open.split('\n')[0] ?? '')));
  return joinable ? groups.slice(0, -1) : groups;
}

function parseCard(part: Extract<Part, { kind: 'card' }>, n: number): { ok: true; doc: UiDoc } | { ok: false; error: string } {
  if (!part.closed) return { ok: false, error: `card ${n}: missing closing fence` };
  let json: unknown;
  try {
    json = JSON.parse(part.body);
  } catch (error) {
    return { ok: false, error: `card ${n}: not valid JSON (${error instanceof Error ? error.message : 'parse error'})` };
  }
  const checked = parseUiDoc(json, 'message');
  return checked.ok ? checked : { ok: false, error: `card ${n}: ${checked.error}` };
}

function build(text: string, split: boolean): ReplyLayout {
  const bubbles: ReplyBubble[] = [];
  const cardErrors: string[] = [];
  let cards = 0;
  /** Index of the last bubble of the text segment right before the part being read, if any. */
  let leadIn: number | null = null;
  for (const part of splitCards(text)) {
    if (part.kind === 'text') {
      const made = segmentBubbles(part.text, split);
      for (const markdown of made) bubbles.push({ markdown });
      leadIn = made.length > 0 ? bubbles.length - 1 : null;
      continue;
    }
    cards += 1;
    const card = parseCard(part, cards);
    const target = leadIn === null ? undefined : bubbles[leadIn];
    leadIn = null;
    if (!card.ok) {
      cardErrors.push(card.error);
      continue;
    }
    if (target !== undefined && target.ui === undefined) target.ui = card.doc;
    else bubbles.push({ markdown: uiDocToText(card.doc), ui: card.doc });
  }
  return { bubbles, cardErrors };
}

/**
 * A reply nobody is waiting on (a routine, a reminder, a finished task) is ONE message: all text in one bubble, in order,
 * with the first valid card attached; any further card is kept as its text form. Broken cards are reported and dropped.
 */
export function layoutSingleMessage(text: string): ReplyLayout {
  const texts: string[] = [];
  const cardErrors: string[] = [];
  let ui: UiDoc | undefined;
  let cards = 0;
  for (const part of splitCards(text)) {
    if (part.kind === 'text') {
      if (part.text.trim().length > 0) texts.push(part.text.trim());
      continue;
    }
    cards += 1;
    const card = parseCard(part, cards);
    if (!card.ok) cardErrors.push(card.error);
    else if (ui === undefined) ui = card.doc;
    else texts.push(uiDocToText(card.doc));
  }
  if (texts.length > 0) return { bubbles: [{ markdown: texts.join('\n\n'), ...(ui === undefined ? {} : { ui }) }], cardErrors };
  if (ui === undefined) return { bubbles: [], cardErrors };
  return { bubbles: [{ markdown: uiDocToText(ui), ui }], cardErrors };
}

/**
 * Lay a final reply out as bubbles. `streamed` is how many bubbles were already posted while it was written
 * (block streaming): past the cap those stay as they are and the rest of the reply becomes the last bubble,
 * instead of the whole reply being unsplit.
 */
export function layoutReply(text: string, streamed = 0): ReplyLayout {
  const layout = build(text, true);
  if (layout.bubbles.length <= MAX_REPLY_BUBBLES) return layout;
  if (streamed === 0) return build(text, false);
  const rest = layout.bubbles.slice(MAX_REPLY_BUBBLES - 1);
  const ui = rest.find((bubble) => bubble.ui !== undefined)?.ui;
  const merged: ReplyBubble = { markdown: rest.map((bubble) => bubble.markdown).join('\n\n'), ...(ui === undefined ? {} : { ui }) };
  return { ...layout, bubbles: [...layout.bubbles.slice(0, MAX_REPLY_BUBBLES - 1), merged] };
}

/** How long a bubble waits before it follows the previous one: a beat to read it, capped. */
export function readingPauseMs(markdown: string): number {
  return Math.min(400 + 15 * [...markdown].length, 2000);
}
