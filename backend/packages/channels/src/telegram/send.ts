/**
 * Telegram Bot API sender: one bot token, plain HTTPS, no app review. HTML parse mode over MarkdownV2: HTML needs three characters
 * escaped (`& < >`), MarkdownV2 eighteen, and one missed character makes Telegram reject the whole message. A rejected parse is
 * still retried once as plain text so the reply is never lost.
 */
import { renderMentions } from '../mentions.js';
import { chunkMarkdown, convertMarkdown, TELEGRAM_HTML, type RichMessage } from '../render.js';
import type { ChannelSender, ChannelSendResult, ChannelSendTarget } from '../types.js';
import { telegramKeyboard, TELEGRAM_SOURCE_CHUNK } from './render.js';

export async function telegramPost(fetchFn: typeof fetch, token: string, method: string, body: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; status: number; error: string }> {
  let response: Response;
  try {
    response = await fetchFn('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const payload: unknown = await response.json().catch(() => null);
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  if (!response.ok || record['ok'] === false) {
    const description = record['description'];
    return { ok: false, status: response.status, error: typeof description === 'string' ? description : method + ' failed' };
  }
  return { ok: true, result: record['result'] };
}

/** `reply_parameters` for a group reply to the message that addressed the bot. */
export function telegramReplyTo(target: ChannelSendTarget): Record<string, unknown> {
  const id = target.replyToMessageId === undefined ? NaN : Number(target.replyToMessageId);
  return Number.isNaN(id) ? {} : { reply_parameters: { message_id: id, allow_sending_without_reply: true } };
}

/** Send a rich message: formatted chunks, the keyboard on the last one. Returns the first message's id. */
export async function sendTelegramRich(fetchFn: typeof fetch, target: ChannelSendTarget, rich: RichMessage): Promise<ChannelSendResult> {
  const token = target.channel.botToken ?? '';
  const sep = target.threadId.indexOf(':');
  const topic = sep === -1 ? undefined : Number(target.threadId.slice(sep + 1));
  const chunks = chunkMarkdown(rich.text, TELEGRAM_SOURCE_CHUNK);
  let firstId: string | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const base = {
      chat_id: target.chatId,
      ...(topic === undefined || Number.isNaN(topic) ? {} : { message_thread_id: topic }),
      ...(index === 0 ? telegramReplyTo(target) : {}),
      ...(index === chunks.length - 1 && rich.buttons.length > 0 ? { reply_markup: telegramKeyboard(rich.buttons) } : {}),
    };
    let sent = await telegramPost(fetchFn, token, 'sendMessage', { ...base, text: convertMarkdown(chunk, TELEGRAM_HTML), parse_mode: 'HTML' });
    if (!sent.ok && sent.status === 400 && /parse entities/i.test(sent.error)) sent = await telegramPost(fetchFn, token, 'sendMessage', { ...base, text: chunk });
    if (!sent.ok) return { ok: false, error: 'Telegram send failed: ' + String(sent.status) + ' ' + sent.error.slice(0, 200) };
    const id = typeof sent.result === 'object' && sent.result !== null ? (sent.result as Record<string, unknown>)['message_id'] : undefined;
    if (firstId === undefined && typeof id === 'number') firstId = String(id);
  }
  return firstId === undefined ? { ok: true } : { ok: true, externalId: firstId };
}

/** Telegram Bot API sender (CH1 adapter). */
export function createTelegramSender(fetchFn: typeof fetch = fetch): ChannelSender {
  return {
    async sendText(target: ChannelSendTarget, text: string): Promise<ChannelSendResult> {
      let response: Response;
      try {
        response = await fetchFn('https://api.telegram.org/bot' + (target.channel.botToken ?? '') + '/sendMessage', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: target.chatId, text: renderMentions(text), ...telegramReplyTo(target) }),
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const suffix = detail ? ' ' + detail.slice(0, 200) : '';
        return { ok: false, error: 'Telegram send failed: ' + String(response.status) + suffix };
      }
      return { ok: true, externalId: await telegramMessageId(response) };
    },
    sendRich: (target, rich) => sendTelegramRich(fetchFn, target, rich),
  };
}

async function telegramMessageId(response: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const result: unknown = (body as Record<string, unknown>)['result'];
  if (typeof result !== 'object' || result === null) return undefined;
  const messageId: unknown = (result as Record<string, unknown>)['message_id'];
  return typeof messageId === 'number' ? String(messageId) : undefined;
}
