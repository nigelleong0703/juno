import { declareCapabilities, NO_HISTORY, plainEmoji } from '@agent-desktop/public-contracts';
import { emojiSkipped, TEXT_ONLY, type ChannelAbilities } from '../abilities.js';
import { downloadFile, fileForm, sizeProblem } from '../files.js';
import { record, sendJson, str } from '../http.js';

/** Telegram's own list of reactions a bot may use; sent as they are. */
export const TELEGRAM_REACTIONS: readonly string[] = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '😢', '🎉', '🤩', '🙏', '👌', '🤡', '😍', '💯', '🤣', '🏆', '😭', '👀', '🙈', '😇', '🤝', '🫡', '😎', '😡', '🤷',
];

/** What a Telegram chat can do: the Bot API cannot read a chat's history, cards have no input fields, reactions are the list above. */
export const telegramCapabilities = () => declareCapabilities({ history: NO_HISTORY, ui: { fields: false }, reactions: { mode: 'limited', allowed: TELEGRAM_REACTIONS } });

/**
 * `setMessageReaction` takes one of Telegram's free reactions. The Bot API cannot read a chat's history (so `history` stays
 * unsupported); taking a reaction back is not used, so `unreact` is unsupported too.
 *
 * Files: `getFile` turns a file id into a path, which is downloaded from the file host with the bot token (the token is in the
 * path, so the error text never names it). `sendDocument` posts a file into a chat, in its topic when the thread names one.
 */
export const telegramAbilities: ChannelAbilities = {
  ...TEXT_ONLY,
  async attachment(fetchFn, auth, file) {
    const res = await sendJson(fetchFn, 'POST', 'https://api.telegram.org/bot' + auth.token + '/getFile', {}, { file_id: file.fileId });
    const path = str(record(res.body['result'])['file_path']);
    if (!res.ok || res.body['ok'] !== true || path === undefined) return { status: 'failed', error: 'Telegram would not give this file: ' + (str(res.body['description']) ?? String(res.status)) };
    return downloadFile(fetchFn, 'https://api.telegram.org/file/bot' + auth.token + '/' + path, ['api.telegram.org']);
  },
  async sendFile(fetchFn, auth, chat, file, caption) {
    const tooBig = sizeProblem(file.bytes);
    if (tooBig !== undefined) return tooBig;
    const sep = chat.threadId.indexOf(':');
    const topic = sep === -1 ? undefined : chat.threadId.slice(sep + 1);
    const fields: Record<string, string> = {
      chat_id: chat.chatId,
      ...(topic === undefined || topic === '' ? {} : { message_thread_id: topic }),
      ...(caption === undefined || caption === '' ? {} : { caption }),
    };
    let response: Response;
    try {
      response = await fetchFn('https://api.telegram.org/bot' + auth.token + '/sendDocument', { method: 'POST', body: fileForm(fields, 'document', file) });
    } catch {
      return { status: 'failed', error: 'Telegram send failed: the request did not reach Telegram' };
    }
    const body = record(await response.json().catch(() => null));
    if (!response.ok || body['ok'] !== true) return { status: 'failed', error: 'Telegram send failed: ' + (str(body['description']) ?? String(response.status)) };
    const id = record(body['result'])['message_id'];
    return { status: 'ok', value: typeof id === 'number' ? { messageId: String(id) } : {} };
  },
  async react(fetchFn, auth, message, emoji) {
    const allowed = TELEGRAM_REACTIONS.find((candidate) => plainEmoji(candidate) === plainEmoji(emoji));
    if (allowed === undefined) return emojiSkipped('Telegram', emoji);
    const res = await sendJson(fetchFn, 'POST', 'https://api.telegram.org/bot' + auth.token + '/setMessageReaction', {}, {
      chat_id: message.chatId,
      message_id: Number(message.messageId),
      reaction: [{ type: 'emoji', emoji: allowed }],
    });
    return res.ok && res.body['ok'] === true ? { status: 'ok', value: {} } : { status: 'failed', error: 'Telegram reaction failed: ' + (str(res.body['description']) ?? String(res.status)) };
  },
};
