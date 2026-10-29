import { declareCapabilities } from '@agent-desktop/public-contracts';
import { emojiSkipped, NOT_YET, platformEmoji, type AdapterAuth, type AdapterResult, type ChannelAbilities, type LocalFile, type MessageRef } from '../abilities.js';
import { record, sendJson, str } from '../http.js';
import { downloadFile, sizeProblem } from '../files.js';
import { fetchSlackHistory } from './history.js';

const BASE = 'https://slack.com/api/';

/** Slack-hosted file URLs; the bot token is only sent to these. */
const FILE_HOSTS = ['files.slack.com'];

/** One Web API call with form fields (the upload-URL calls take form-encoded bodies); never throws. */
async function slackForm(fetchFn: typeof fetch, token: string, method: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  try {
    const response = await fetchFn(BASE + method, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: new URLSearchParams(fields) });
    return record(await response.json().catch(() => null));
  } catch {
    return { ok: false, error: 'request_failed' };
  }
}

/**
 * Files out, the three-step upload: `files.getUploadURLExternal` (a URL and an id), the bytes POSTed to that URL, then
 * `files.completeUploadExternal` shares the file to the channel (in its thread when the thread names one). Scope files:write.
 */
async function sendSlackFile(fetchFn: typeof fetch, auth: AdapterAuth, chat: { chatId: string; threadId: string }, file: LocalFile, caption?: string): Promise<AdapterResult<{ messageId?: string }>> {
  const tooBig = sizeProblem(file.bytes);
  if (tooBig !== undefined) return tooBig;
  const ticket = await slackForm(fetchFn, auth.token, 'files.getUploadURLExternal', { filename: file.name, length: String(file.bytes.length) });
  const uploadUrl = str(ticket['upload_url']);
  const fileId = str(ticket['file_id']);
  if (ticket['ok'] !== true || uploadUrl === undefined || fileId === undefined) return { status: 'failed', error: 'Slack upload failed: ' + (str(ticket['error']) ?? 'no upload URL') };
  let uploaded: Response;
  try {
    uploaded = await fetchFn(uploadUrl, { method: 'POST', headers: { 'content-type': file.mime }, body: file.bytes });
  } catch {
    return { status: 'failed', error: 'Slack upload failed: the bytes did not reach Slack' };
  }
  if (!uploaded.ok) return { status: 'failed', error: 'Slack upload failed: HTTP ' + String(uploaded.status) };
  const sep = chat.threadId.indexOf(':');
  const threadTs = sep === -1 ? undefined : chat.threadId.slice(sep + 1);
  const done = await sendJson(fetchFn, 'POST', BASE + 'files.completeUploadExternal', { authorization: 'Bearer ' + auth.token }, {
    files: [{ id: fileId, title: file.name }],
    channel_id: chat.chatId,
    ...(threadTs === undefined || threadTs === '' ? {} : { thread_ts: threadTs }),
    ...(caption === undefined || caption === '' ? {} : { initial_comment: caption }),
  });
  return done.ok && done.body['ok'] === true ? { status: 'ok', value: {} } : { status: 'failed', error: 'Slack share failed: ' + (str(done.body['error']) ?? String(done.status)) };
}

/** `reactions.add` / `reactions.remove` (scope reactions:write). Slack names emoji by short name, so the emoji must be in our map; asking twice is fine. */
async function reaction(fetchFn: typeof fetch, auth: AdapterAuth, method: 'reactions.add' | 'reactions.remove', message: MessageRef, emoji: string): Promise<AdapterResult> {
  const name = platformEmoji(SLACK_REACTIONS, emoji);
  if (name === undefined) return emojiSkipped('Slack', emoji);
  const res = await sendJson(fetchFn, 'POST', BASE + method, { authorization: 'Bearer ' + auth.token }, { channel: message.chatId, timestamp: message.messageId, name });
  const error = str(res.body['error']);
  if (res.ok && res.body['ok'] === true) return { status: 'ok', value: undefined };
  return error === 'already_reacted' || error === 'no_reaction' ? { status: 'ok', value: undefined } : { status: 'failed', error: 'Slack reaction failed: ' + (error ?? String(res.status)) };
}

const EXTERNAL_TTL_MS = 60 * 60_000;
const externalCache = new Map<string, { external: boolean; missingScope: boolean; at: number }>();

/** The answer: `external` for the quiet rule; `missingScope` when the app lacks channels:read / groups:read, so the answer is "not external" for lack of data (the caller logs it once). */
export interface SlackExternalAnswer {
  external: boolean;
  missingScope: boolean;
}

/**
 * Whether a channel is a Slack Connect channel shared with another organization (`conversations.info` → `is_ext_shared`, scope
 * channels:read / groups:read). Cached an hour per channel. Missing scope (`missing_scope`): not external, cached, so a Slack app
 * without the read scope does not turn every group quiet. Any other failure (network, rate limit) answers external without caching,
 * so the group stays quiet until a later event can be read.
 */
export async function slackChannelExternal(fetchFn: typeof fetch, token: string, channelId: string): Promise<SlackExternalAnswer> {
  const hit = externalCache.get(channelId);
  if (hit !== undefined && Date.now() - hit.at < EXTERNAL_TTL_MS) return { external: hit.external, missingScope: hit.missingScope };
  let body: Record<string, unknown>;
  try {
    const response = await fetchFn(BASE + 'conversations.info?channel=' + encodeURIComponent(channelId), { headers: { authorization: 'Bearer ' + token } });
    body = record(await response.json().catch(() => null));
  } catch {
    return { external: true, missingScope: false };
  }
  if (body['ok'] !== true) {
    if (body['error'] === 'missing_scope') {
      externalCache.set(channelId, { external: false, missingScope: true, at: Date.now() });
      return { external: false, missingScope: true };
    }
    return { external: true, missingScope: false };
  }
  const external = record(body['channel'])['is_ext_shared'] === true;
  externalCache.set(channelId, { external, missingScope: false, at: Date.now() });
  return { external, missingScope: false };
}

/** Slack's own names for the emoji the agent may react with (also the set it is offered). */
export const SLACK_REACTIONS: Readonly<Record<string, string>> = {
  '👍': '+1', '👎': '-1', '❤️': 'heart', '😂': 'joy', '😄': 'smile', '🎉': 'tada', '👀': 'eyes', '✅': 'white_check_mark', '❌': 'x',
  '🙏': 'pray', '🔥': 'fire', '🤔': 'thinking_face', '👏': 'clap', '💯': '100', '😢': 'cry', '🚀': 'rocket',
};

/** What a Slack chat can do: no input fields in cards, only the reactions above. */
export const slackCapabilities = () => declareCapabilities({ ui: { fields: false }, reactions: { mode: 'limited', allowed: Object.keys(SLACK_REACTIONS) } });

/** Slack's capability layer. Its communication layer is `createSlackSender` and the Events API (agentd). */
export const slackAbilities: ChannelAbilities = {
  ...NOT_YET,
  react: async (fetchFn, auth, message, emoji) => {
    const result = await reaction(fetchFn, auth, 'reactions.add', message, emoji);
    return result.status === 'ok' ? { status: 'ok', value: {} } : result;
  },
  unreact: (fetchFn, auth, message, emoji) => reaction(fetchFn, auth, 'reactions.remove', message, emoji),
  async history(fetchFn, auth, chat) {
    const messages = await fetchSlackHistory(fetchFn, auth.token, chat);
    return messages === undefined
      ? { status: 'failed', error: 'Slack would not give this channel\'s history (the app needs channels:history / groups:history and to be in the channel)' }
      : { status: 'ok', value: messages };
  },
  // `fileId` is the file's url_private (see slackFiles); the bot token goes only to files.slack.com.
  attachment: (fetchFn, auth, file) => downloadFile(fetchFn, file.fileId, FILE_HOSTS, { authorization: 'Bearer ' + auth.token }),
  sendFile: sendSlackFile,
};
