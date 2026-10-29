/**
 * Telegram adapter pieces (CH2): the update parser and a thin Bot API client.
 *
 * `parseTelegramUpdate` turns a raw Telegram update into the normalized channel event the ingress
 * admits, or null when the update is not something the agent should hear (edits, channel posts, bots,
 * non-text, group chatter that does not address the bot). The API client sits behind an injectable
 * fetch so tests never touch the network; error text never carries the bot token.
 */
import { z } from 'zod';
import type { ChannelFile, ChannelInboundEvent, ChannelPerson } from '../types.js';

const userSchema = z.object({
  id: z.number(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

/** A file object of a message (document, audio, video, voice); `file_id` is what getFile takes. */
const fileObjectSchema = z.object({ file_id: z.string(), file_name: z.string().optional(), mime_type: z.string().optional(), file_size: z.number().optional() });
const entitySchema = z.object({ type: z.string(), offset: z.number(), length: z.number(), user: userSchema.optional() });

const messageSchema = z.object({
  message_id: z.number(),
  message_thread_id: z.number().optional(),
  is_topic_message: z.boolean().optional(),
  from: userSchema.optional(),
  chat: z.object({ id: z.number(), type: z.string(), title: z.string().optional() }),
  text: z.string().optional(),
  entities: z.array(entitySchema).optional(),
  /** A file's caption is the text of the message; its entities are `caption_entities`. */
  caption: z.string().optional(),
  caption_entities: z.array(entitySchema).optional(),
  document: fileObjectSchema.optional(),
  photo: z.array(z.object({ file_id: z.string(), file_size: z.number().optional() })).optional(),
  video: fileObjectSchema.optional(),
  audio: fileObjectSchema.optional(),
  voice: fileObjectSchema.optional(),
  reply_to_message: z.object({ from: userSchema.optional() }).optional(),
});

/** The files of a message: a document, the largest photo size, a video, audio or voice note. */
function telegramFiles(message: z.infer<typeof messageSchema>): ChannelFile[] {
  const files: ChannelFile[] = [];
  const add = (fileId: string, name: string, mimeType: string | undefined, sizeBytes: number | undefined): void => {
    files.push({ fileId, name, ...(mimeType === undefined ? {} : { mimeType }), ...(sizeBytes === undefined ? {} : { sizeBytes }) });
  };
  if (message.document) add(message.document.file_id, message.document.file_name ?? 'document', message.document.mime_type, message.document.file_size);
  const largest = message.photo?.at(-1);
  if (largest) add(largest.file_id, 'photo.jpg', 'image/jpeg', largest.file_size);
  if (message.video) add(message.video.file_id, message.video.file_name ?? 'video', message.video.mime_type, message.video.file_size);
  if (message.audio) add(message.audio.file_id, message.audio.file_name ?? 'audio', message.audio.mime_type, message.audio.file_size);
  if (message.voice) add(message.voice.file_id, 'voice.ogg', message.voice.mime_type ?? 'audio/ogg', message.voice.file_size);
  return files;
}

const updateSchema = z.object({ update_id: z.number(), message: messageSchema.optional() });

/** The normalized event (same shape the CH1 ingress body carries). */
export interface TelegramChannelEvent extends ChannelInboundEvent {
  chatTitle?: string;
}

function telegramName(user: z.infer<typeof userSchema>): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || '';
}

export function parseTelegramUpdate(update: unknown, botUsername: string): TelegramChannelEvent | null {
  const parsed = updateSchema.safeParse(update);
  const message = parsed.success ? parsed.data.message : undefined;
  if (!message || message.from === undefined || message.from.is_bot === true) return null;
  const files = telegramFiles(message);
  // A file message has no text: its caption is the text, and the caption's entities hold the mentions.
  const body = message.text ?? message.caption;
  if (body === undefined && files.length === 0) return null;
  const chatType = message.chat.type === 'private' ? 'private' : message.chat.type === 'group' || message.chat.type === 'supergroup' ? 'group' : null;
  if (chatType === null) return null;
  const mention = '@' + botUsername.toLowerCase();
  let text = body ?? '';
  const entities = (message.text === undefined ? message.caption_entities : message.entities) ?? [];
  const botMentions = chatType === 'group'
    ? entities.filter((entity) => entity.type === 'mention' && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === mention)
    : [];
  if (chatType === 'group') {
    const replier = message.reply_to_message?.from;
    const repliesToBot = replier?.is_bot === true && replier.username?.toLowerCase() === botUsername.toLowerCase();
    if (botMentions.length === 0 && !repliesToBot) return null;
  }
  // Strip the bot's own mention and read other people's `text_mention` as `@Name` (a plain `@username` already reads as itself),
  // from the end so earlier offsets stay valid.
  const mentions: ChannelPerson[] = [];
  const edits = [...botMentions.map((entity) => ({ entity, user: undefined })), ...entities.filter((entity) => entity.type === 'text_mention' && entity.user !== undefined && entity.user.is_bot !== true).map((entity) => ({ entity, user: entity.user }))];
  for (const { entity, user } of edits.sort((a, b) => b.entity.offset - a.entity.offset)) {
    const name = user === undefined ? '' : telegramName(user);
    text = text.slice(0, entity.offset) + (user === undefined || name === '' ? '' : '@' + name) + text.slice(entity.offset + entity.length);
    if (user !== undefined && name !== '') mentions.unshift({ id: String(user.id), name, ...(user.username === undefined ? {} : { handle: user.username }) });
  }
  if (chatType === 'group') text = text.trim();
  if (text.trim().length === 0 && files.length === 0) return null;
  const chatId = String(message.chat.id);
  const threadId = message.is_topic_message === true && message.message_thread_id !== undefined
    ? chatId + ':' + String(message.message_thread_id)
    : chatId;
  const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ') || message.from.username || '';
  return {
    chatId,
    chatType,
    threadId,
    externalMessageId: chatId + ':' + String(message.message_id),
    from: { id: String(message.from.id), name, ...(message.from.username === undefined ? {} : { handle: message.from.username }) },
    text,
    ...(mentions.length === 0 ? {} : { mentions }),
    ...(files.length === 0 ? {} : { files }),
    ...(chatType === 'group' && message.chat.title ? { chatTitle: message.chat.title } : {}),
  };
}

export type TelegramCall = { ok: true; result: unknown } | { ok: false; status: number; error: string };

export interface TelegramApi {
  getMe(token: string): Promise<{ ok: true; username: string } | { ok: false; status: number; error: string }>;
  setWebhook(token: string, url: string, secret: string): Promise<TelegramCall>;
  deleteWebhook(token: string): Promise<TelegramCall>;
  /** The token of a bot the manager bot manages (Bot API 9.6 `getManagedBotToken`). */
  getManagedBotToken(token: string, botUserId: number): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }>;
  getUpdates(token: string, offset: number | undefined, signal?: AbortSignal, allowedUpdates?: string[]): Promise<{ ok: true; updates: unknown[] } | { ok: false; status: number; error: string }>;
}

/** Bot API client. A transport failure is status 0; Telegram's own refusals keep their HTTP status. */
export function createTelegramApi(fetchFn: typeof fetch = fetch): TelegramApi {
  async function call(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<TelegramCall> {
    let response: Response;
    try {
      response = await fetchFn('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
    const payload: unknown = await response.json().catch(() => null);
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    if (!response.ok || record['ok'] !== true) {
      const description = record['description'];
      return { ok: false, status: response.status, error: typeof description === 'string' ? description : 'Telegram ' + method + ' failed' };
    }
    return { ok: true, result: record['result'] };
  }
  return {
    async getMe(token) {
      const res = await call(token, 'getMe', {});
      if (!res.ok) return res;
      const username = typeof res.result === 'object' && res.result !== null ? (res.result as Record<string, unknown>)['username'] : undefined;
      return typeof username === 'string' && username.length > 0
        ? { ok: true, username }
        : { ok: false, status: 400, error: 'Bot has no username' };
    },
    setWebhook: (token, url, secret) => call(token, 'setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'] }),
    deleteWebhook: (token) => call(token, 'deleteWebhook', {}),
    async getManagedBotToken(token, botUserId) {
      const res = await call(token, 'getManagedBotToken', { user_id: botUserId });
      if (!res.ok) return res;
      return typeof res.result === 'string' && res.result.length > 0
        ? { ok: true, token: res.result }
        : { ok: false, status: 400, error: 'Telegram returned no managed bot token' };
    },
    async getUpdates(token, offset, signal, allowedUpdates = ['message', 'callback_query']) {
      const res = await call(token, 'getUpdates', { timeout: 25, allowed_updates: allowedUpdates, ...(offset === undefined ? {} : { offset }) }, signal);
      if (!res.ok) return res;
      return { ok: true, updates: Array.isArray(res.result) ? res.result : [] };
    },
  };
}
