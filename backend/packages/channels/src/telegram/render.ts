/**
 * Telegram rich messages: the inline keyboard under the last chunk. `callback_data` is the `jn:` token (well under Telegram's
 * 64 bytes), which names the stored item or request.
 */
import type { RichButton } from '../render.js';

export const TELEGRAM_TEXT_LIMIT = 4096;
/** Markdown source per message: HTML tags add some length, so the source stays well under the hard limit. */
export const TELEGRAM_SOURCE_CHUNK = 3000;

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Two short buttons share a row; a longer label gets its own. */
export function telegramKeyboard(buttons: RichButton[]): InlineKeyboard {
  const rows: InlineKeyboard['inline_keyboard'] = [];
  for (const button of buttons) {
    const cell = { text: button.label.slice(0, 64), callback_data: button.id };
    const last = rows[rows.length - 1];
    if (last !== undefined && last.length === 1 && last[0] !== undefined && last[0].text.length <= 14 && cell.text.length <= 14) last.push(cell);
    else rows.push([cell]);
  }
  return { inline_keyboard: rows };
}

/** What replaces the keyboard once a button was tapped: one inert button showing the choice. */
export function chosenKeyboard(label: string): InlineKeyboard {
  return { inline_keyboard: [[{ text: '✓ ' + label.slice(0, 60), callback_data: 'jn:x' }]] };
}
