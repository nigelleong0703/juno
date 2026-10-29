/**
 * Telegram button taps (`callback_query`): answer the query (clears the spinner, or tells a non-owner why not) and replace the
 * keyboard with the chosen option so it cannot be tapped twice.
 */
import { z } from 'zod';
import { NOT_OWNER_TEXT, STALE_TEXT, type ParsedClick } from '../click.js';
import { chosenKeyboard } from './render.js';
import { telegramPost } from './send.js';

const callbackSchema = z.object({
  update_id: z.number(),
  callback_query: z.object({
    id: z.string(),
    data: z.string().optional(),
    from: z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional(), last_name: z.string().optional(), username: z.string().optional() }),
    message: z.object({ message_id: z.number(), chat: z.object({ id: z.number() }) }).optional(),
  }),
});

/** A `callback_query` update on one of our buttons, or undefined for anything else. */
export function parseTelegramClick(update: unknown): ParsedClick | undefined {
  const parsed = callbackSchema.safeParse(update);
  if (!parsed.success) return undefined;
  const query = parsed.data.callback_query;
  if (query.data === undefined || !query.data.startsWith('jn:') || query.from.is_bot === true) return undefined;
  const name = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ') || query.from.username || '';
  const chatId = query.message === undefined ? undefined : String(query.message.chat.id);
  const messageId = query.message?.message_id;
  return {
    token: query.data,
    from: { id: String(query.from.id), name },
    async ack({ fetchFn, token }, outcome) {
      if (token === undefined) return undefined;
      if (outcome.status === 'done') {
        await telegramPost(fetchFn, token, 'answerCallbackQuery', { callback_query_id: query.id });
        if (chatId !== undefined && messageId !== undefined) {
          await telegramPost(fetchFn, token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: chosenKeyboard(outcome.label) });
        }
      } else {
        await telegramPost(fetchFn, token, 'answerCallbackQuery', { callback_query_id: query.id, text: outcome.status === 'not-owner' ? NOT_OWNER_TEXT : STALE_TEXT, show_alert: true });
      }
      return undefined;
    },
  };
}
