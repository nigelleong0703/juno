/**
 * How a run's final reply text becomes a chat bubble.
 *
 * A final reply is ONE bubble, paragraphs and all; nothing is split by blank lines, colons or lists. When the model wants
 * several messages it says so itself: send_message with `messages`, then it ends its turn without text. A fenced block with
 * the info string `card` holds one UiDoc JSON object; the first valid card is attached to the bubble, any further card is kept
 * as its text form, and a broken one is reported in `cardErrors` and dropped. Pure: the same text always yields the same layout.
 */
import { parseUiDoc, uiDocToText, type UiDoc } from '@agent-desktop/public-contracts';

export interface ReplyBubble { markdown: string; ui?: UiDoc }
export interface ReplyLayout { bubble?: ReplyBubble; cardErrors: string[] }

type Part = { kind: 'text'; text: string } | { kind: 'card'; body: string; closed: boolean };

const CARD_OPEN = /^```card[ \t]*$/;
const CARD_CLOSE = /^```[ \t]*$/;

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

/**
 * Lay a reply out as its one bubble: all text in one bubble, in order, with the first valid card attached; any further card is
 * kept as its text form. Broken cards are reported and dropped. Blank text and no card is no bubble at all.
 */
export function layoutReply(text: string): ReplyLayout {
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
  if (texts.length > 0) return { bubble: { markdown: texts.join('\n\n'), ...(ui === undefined ? {} : { ui }) }, cardErrors };
  if (ui === undefined) return { cardErrors };
  return { bubble: { markdown: uiDocToText(ui), ui }, cardErrors };
}

/** How long a message waits before it follows the previous one: a beat to read it, capped. */
export function readingPauseMs(markdown: string): number {
  return Math.min(400 + 15 * [...markdown].length, 2000);
}
