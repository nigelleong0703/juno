import { declareCapabilities, NO_HISTORY } from '@agent-desktop/public-contracts';
import { emojiSkipped, NOT_YET, platformEmoji, type AdapterAuth, type AdapterResult, type ChannelAbilities, type LocalFile } from '../abilities.js';
import { downloadFile, fileForm, sizeProblem } from '../files.js';
import { record, str } from '../http.js';
import type { ChannelMessage } from '../types.js';
import { feishuBaseUrl, feishuCall, getTenantToken, type FeishuCredentials } from './api.js';

/** Feishu's own emoji types for the emoji the agent may react with (also the set it is offered once the reactions permission is granted). */
export const FEISHU_REACTIONS: Readonly<Record<string, string>> = {
  '👍': 'THUMBSUP', '👌': 'OK', '👏': 'APPLAUSE', '😄': 'SMILE', '😂': 'LAUGH', '❤️': 'HEART', '✅': 'DONE', '🙏': 'THANKS', '💪': 'MUSCLE', '🔥': 'FIRE', '😢': 'CRY',
};

/** Optional Feishu permissions (the tenant admin approves them): a Feishu chat's capabilities widen only when the app was granted one. */
export const FEISHU_SCOPE_GROUP_MESSAGES = 'im:message.group_msg';
export const FEISHU_SCOPE_REACTIONS = 'im:message.reactions:write_only';

/** What a Feishu chat can do: no history and no reactions until the optional permissions were granted (`grants`), no input fields in cards. */
export function feishuCapabilities(grants: readonly string[]) {
  const base = declareCapabilities({ history: NO_HISTORY, ui: { fields: false }, reactions: { mode: 'none' } });
  return {
    ...base,
    history: grants.includes(FEISHU_SCOPE_GROUP_MESSAGES) ? { ...base.history, onDemand: true } : base.history,
    reactions: grants.includes(FEISHU_SCOPE_REACTIONS) ? { mode: 'limited' as const, allowed: Object.keys(FEISHU_REACTIONS) } : base.reactions,
  };
}

/** Feishu's answer when the app lacks the scope a call needs ("Access denied. scope …"). */
export const FEISHU_NO_PERMISSION = 99991672;

/** Whether a failed Feishu call (its error text carries the code, see the calls below) was refused for a missing scope. */
export function feishuPermissionDenied(error: string | undefined): boolean {
  return error !== undefined && error.includes(String(FEISHU_NO_PERMISSION));
}

function credsOf(auth: AdapterAuth): FeishuCredentials {
  return { appId: auth.appId ?? '', appSecret: auth.token, ...(auth.domain === undefined ? {} : { domain: auth.domain }) };
}

/**
 * `GET /im/v1/messages/{message_id}/resources/{file_key}?type=image|file` : the bytes of a file or image of a message. Scope: one of
 * im:message, im:message:readonly, im:message.history:readonly (official resource-download page). The bot must be in the chat, and
 * the download fails in external groups (error 234009). Feishu's own limit is 100 MB; ours is the app cap. Image keys start with `img_`.
 */
async function attachmentOf(fetchFn: typeof fetch, auth: AdapterAuth, file: { messageId: string; fileId: string }): Promise<AdapterResult<{ bytes: Uint8Array; mime?: string }>> {
  const creds = credsOf(auth);
  const token = await getTenantToken(fetchFn, creds);
  if (!token.ok) return { status: 'failed', error: 'Feishu would not give this file: ' + String(token.code ?? token.status) + ' ' + token.error };
  const base = feishuBaseUrl(creds.domain);
  const type = file.fileId.startsWith('img_') ? 'image' : 'file';
  const url = base + '/open-apis/im/v1/messages/' + encodeURIComponent(file.messageId) + '/resources/' + encodeURIComponent(file.fileId) + '?type=' + type;
  return downloadFile(fetchFn, url, [new URL(base).hostname], { authorization: 'Bearer ' + token.data });
}

/** `POST /im/v1/files` (multipart, the bytes as `file`, `file_type` stream) then a file message carrying the returned file_key: into the chat, or as a reply in the thread. Scope im:resource. */
async function sendFeishuFile(fetchFn: typeof fetch, auth: AdapterAuth, chat: { chatId: string; threadId: string }, file: LocalFile): Promise<AdapterResult<{ messageId?: string }>> {
  const tooBig = sizeProblem(file.bytes);
  if (tooBig !== undefined) return tooBig;
  const creds = credsOf(auth);
  const token = await getTenantToken(fetchFn, creds);
  if (!token.ok) return { status: 'failed', error: 'Feishu send failed: ' + String(token.code ?? token.status) + ' ' + token.error };
  let uploadedRes: Response;
  try {
    uploadedRes = await fetchFn(feishuBaseUrl(creds.domain) + '/open-apis/im/v1/files', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token.data },
      body: fileForm({ file_type: 'stream', file_name: file.name }, 'file', file),
    });
  } catch {
    return { status: 'failed', error: 'Feishu send failed: the upload did not reach Feishu' };
  }
  const uploaded = record(await uploadedRes.json().catch(() => null));
  const fileKey = str(record(uploaded['data'])['file_key']);
  if (!uploadedRes.ok || uploaded['code'] !== 0 || fileKey === undefined) return { status: 'failed', error: 'Feishu upload failed: ' + String(uploaded['code'] ?? uploadedRes.status) + ' ' + (str(uploaded['msg']) ?? '') };
  const content = JSON.stringify({ file_key: fileKey });
  const sep = chat.threadId.indexOf(':');
  const root = sep === -1 ? undefined : chat.threadId.slice(sep + 1);
  const sent = root === undefined || root === ''
    ? await feishuCall(fetchFn, creds, 'POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', { receive_id: chat.chatId, msg_type: 'file', content })
    : await feishuCall(fetchFn, creds, 'POST', '/open-apis/im/v1/messages/' + encodeURIComponent(root) + '/reply', { msg_type: 'file', content });
  if (!sent.ok) return { status: 'failed', error: 'Feishu send failed: ' + String(sent.code ?? sent.status) + ' ' + sent.error };
  const id = str(record(sent.data['data'])['message_id']);
  return { status: 'ok', value: id === undefined ? {} : { messageId: id } };
}

/** One message of `GET /im/v1/messages`: text messages only, `@_user_N` placeholders read as `@Name`. */
function parseMessage(raw: unknown): ChannelMessage | undefined {
  const msg = record(raw);
  if (str(msg['msg_type']) !== 'text') return undefined;
  let text: string;
  try {
    const content = record(JSON.parse(str(record(msg['body'])['content']) ?? '{}'));
    text = str(content['text']) ?? '';
  } catch {
    return undefined;
  }
  const people = new Map<string, string>();
  if (Array.isArray(msg['mentions'])) {
    for (const mention of msg['mentions']) {
      const m = record(mention);
      const key = str(m['key']);
      const name = str(m['name']);
      if (key !== undefined && name !== undefined) text = text.split(key).join('@' + name);
      const id = str(m['id']);
      if (id !== undefined && name !== undefined) people.set(id, name);
    }
  }
  const sender = record(msg['sender']);
  const id = str(sender['id']) ?? '';
  const ms = Number(str(msg['create_time']));
  return {
    id: str(msg['message_id']) ?? '',
    at: Number.isFinite(ms) ? new Date(ms).toISOString() : '',
    text: text.trim(),
    // The message list carries ids, not names: a person only the mentions name keeps that name, the others read "someone".
    author: { id, name: people.get(id) ?? 'someone', isBot: str(sender['sender_type']) === 'app' },
  };
}

/**
 * Reactions need `im:message.reactions:write_only`; reading a group's messages needs `im:message.group_msg` (the tenant admin
 * approves both, so neither is asked for by default and the capability table is closed until the row says they were granted).
 */
export const feishuAbilities: ChannelAbilities = {
  ...NOT_YET,
  async react(fetchFn, auth, message, emoji) {
    const type = platformEmoji(FEISHU_REACTIONS, emoji);
    if (type === undefined) return emojiSkipped('Feishu', emoji);
    const res = await feishuCall(fetchFn, credsOf(auth), 'POST', '/open-apis/im/v1/messages/' + encodeURIComponent(message.messageId) + '/reactions', { reaction_type: { emoji_type: type } });
    if (!res.ok) return { status: 'failed', error: 'Feishu reaction failed: ' + String(res.code ?? res.status) + ' ' + res.error };
    const reactionId = str(record(res.data['data'])['reaction_id']);
    return { status: 'ok', value: reactionId === undefined ? {} : { reactionId } };
  },
  async unreact(fetchFn, auth, message, _emoji, reactionId) {
    if (reactionId === undefined) return { status: 'unsupported' };
    const res = await feishuCall(fetchFn, credsOf(auth), 'DELETE', '/open-apis/im/v1/messages/' + encodeURIComponent(message.messageId) + '/reactions/' + encodeURIComponent(reactionId));
    return res.ok ? { status: 'ok', value: undefined } : { status: 'failed', error: 'Feishu reaction removal failed: ' + String(res.code ?? res.status) + ' ' + res.error };
  },
  async history(fetchFn, auth, chat) {
    const limit = Math.min(chat.limit ?? 30, 50);
    const beforeMs = chat.beforeAt === undefined ? NaN : Date.parse(chat.beforeAt);
    // One more than asked: the message that woke the agent is the newest and is left out below.
    const query = 'container_id_type=chat&container_id=' + encodeURIComponent(chat.chatId) + '&sort_type=ByCreateTimeDesc&page_size=' + String(Math.min(limit + 1, 50))
      + (Number.isFinite(beforeMs) ? '&end_time=' + String(Math.floor(beforeMs / 1000)) : '');
    const res = await feishuCall(fetchFn, credsOf(auth), 'GET', '/open-apis/im/v1/messages?' + query);
    if (!res.ok) return { status: 'failed', error: 'Feishu would not give this chat\'s messages: ' + String(res.code ?? res.status) + ' ' + res.error };
    const items = record(res.data['data'])['items'];
    const messages = (Array.isArray(items) ? items : [])
      .map(parseMessage)
      .filter((message): message is ChannelMessage => message !== undefined && message.text !== '' && message.id !== chat.beforeId && (!Number.isFinite(beforeMs) || Date.parse(message.at) < beforeMs));
    return { status: 'ok', value: messages.slice(0, limit).reverse() };
  },
  attachment: attachmentOf,
  sendFile: sendFeishuFile,
};
