import { declareCapabilities } from '@agent-desktop/public-contracts';
import { NOT_YET, type AdapterResult, type ChannelAbilities, type LocalFile, type MessageRef } from '../abilities.js';
import { downloadFile, fileForm, sizeProblem } from '../files.js';
import { record, sendJson, str } from '../http.js';
import { DISCORD_API } from './api.js';
import { fetchDiscordHistory } from './history.js';

/**
 * Discord's attachment CDN: the files of a message are read from these hosts only (no credentials are sent). The attachment docs
 * (docs.discord.com, resources/message#attachment-object) give `url` as "source url of file" without naming the host, so a file
 * on any other host is refused (and skipped) rather than fetched.
 */
const CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

/** Any Unicode emoji can be a reaction (the install asks for ADD_REACTIONS); a server's custom emoji are not supported. */
function reactionUrl(message: MessageRef, emoji: string): string {
  return DISCORD_API + '/channels/' + message.chatId + '/messages/' + message.messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me';
}

function done(res: { ok: boolean; status: number; body: Record<string, unknown> }): AdapterResult<{ reactionId?: string }> {
  return res.ok ? { status: 'ok', value: {} } : { status: 'failed', error: 'Discord reaction failed: ' + (str(res.body['message']) ?? String(res.status)) };
}

/**
 * Files out: one multipart message (`payload_json` with the caption, the bytes as `files[0]`). The bot needs Attach Files in the
 * channel (it is part of the install permissions).
 */
async function sendDiscordFile(fetchFn: typeof fetch, auth: { token: string }, chat: { chatId: string }, file: LocalFile, caption?: string): Promise<AdapterResult<{ messageId?: string }>> {
  const tooBig = sizeProblem(file.bytes);
  if (tooBig !== undefined) return tooBig;
  // Discord's upload form: the message JSON in `payload_json`, its `attachments` naming the file by its `files[n]` index.
  const payload = { content: caption ?? '', attachments: [{ id: 0, filename: file.name }] };
  const form = fileForm({ payload_json: JSON.stringify(payload) }, 'files[0]', file);
  let response: Response;
  try {
    response = await fetchFn(DISCORD_API + '/channels/' + chat.chatId + '/messages', { method: 'POST', headers: { authorization: 'Bot ' + auth.token }, body: form });
  } catch {
    return { status: 'failed', error: 'Discord send failed: the request did not reach Discord' };
  }
  const body = record(await response.json().catch(() => null));
  if (!response.ok) return { status: 'failed', error: 'Discord send failed: ' + (str(body['message']) ?? String(response.status)) };
  const id = str(body['id']);
  return { status: 'ok', value: id === undefined ? {} : { messageId: id } };
}

/** What a Discord chat can do: no input fields in cards; ADD_REACTIONS and ATTACH_FILES are part of the install permissions. */
export const discordCapabilities = () => declareCapabilities({ ui: { fields: false } });

/** Discord's capability layer. Its communication layer is `createDiscordSender` and the Gateway (agentd). */
export const discordAbilities: ChannelAbilities = {
  ...NOT_YET,
  react: async (fetchFn, auth, message, emoji) => done(await sendJson(fetchFn, 'PUT', reactionUrl(message, emoji), { authorization: 'Bot ' + auth.token })),
  unreact: async (fetchFn, auth, message, emoji) => {
    const result = done(await sendJson(fetchFn, 'DELETE', reactionUrl(message, emoji), { authorization: 'Bot ' + auth.token }));
    return result.status === 'ok' ? { status: 'ok', value: undefined } : result;
  },
  async history(fetchFn, auth, chat) {
    const messages = await fetchDiscordHistory(fetchFn, auth.token, chat);
    return messages === undefined ? { status: 'failed', error: 'Discord would not give this channel\'s history (the bot needs View Channel and Read Message History there)' } : { status: 'ok', value: messages };
  },
  // `fileId` is the attachment's CDN url (see parseDiscordMessage).
  attachment: (fetchFn, _auth, file) => downloadFile(fetchFn, file.fileId, CDN_HOSTS),
  sendFile: sendDiscordFile,
};
