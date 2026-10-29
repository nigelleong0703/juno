/**
 * Feishu / Lark rich messages: an interactive card (markdown elements, one row of buttons). A button's `value` carries the `jn:`
 * token. Card text is cut into markdown elements, and capped well under the card size limit.
 */
import { chunkMarkdown, convertMarkdown, FEISHU_MARKDOWN, type ButtonStyle, type RichButton, type RichMessage } from '../render.js';

const ELEMENT_LIMIT = 3500;
/** Characters of text in one card; the rest is cut (a card is limited to about 30 KB). */
const CARD_TEXT_LIMIT = 20_000;

const BUTTON_TYPE: Record<ButtonStyle, string> = { primary: 'primary', default: 'default', danger: 'danger' };

export type FeishuCard = Record<string, unknown>;

function textElements(markdown: string): FeishuCard[] {
  const capped = markdown.length > CARD_TEXT_LIMIT ? markdown.slice(0, CARD_TEXT_LIMIT) + '…' : markdown;
  return chunkMarkdown(capped, ELEMENT_LIMIT).map((chunk) => ({ tag: 'markdown', content: convertMarkdown(chunk, FEISHU_MARKDOWN) }));
}

function buttonRow(buttons: RichButton[]): FeishuCard {
  return {
    tag: 'action',
    actions: buttons.slice(0, 20).map((button) => ({ tag: 'button', text: { tag: 'plain_text', content: button.label.slice(0, 60) }, type: BUTTON_TYPE[button.style], value: { t: button.id } })),
  };
}

export function feishuCard(rich: RichMessage, chosen?: string): FeishuCard {
  const elements = textElements(rich.text);
  if (chosen !== undefined) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '✓ ' + chosen }] });
  else if (rich.buttons.length > 0) elements.push(buttonRow(rich.buttons));
  return { config: { wide_screen_mode: true, update_multi: true }, elements };
}
