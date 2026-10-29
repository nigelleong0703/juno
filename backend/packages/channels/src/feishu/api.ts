/**
 * Feishu / Lark adapter pieces: the im.message.receive_v1 parser, a tenant_access_token cache, and the
 * send client. One `feishu` kind serves both clouds; the row's `domain` picks the API base URL. The
 * app_secret is the row's sealed `botToken`. Everything sits behind an injectable fetch.
 */
import { z } from 'zod';
import type { ChannelFile, ChannelInboundEvent, ChannelPerson, ChannelSender, ChannelSendResult, ChannelSendTarget } from '../types.js';
import { renderMentions } from '../mentions.js';
import { feishuCard } from './render.js';
import type { RichMessage } from '../render.js';

export type FeishuDomain = 'feishu' | 'lark';

/** Message types the parser reads: text, and the files (an image by its image_key, the others by file_key, see parseFeishuMessage). */
const FEISHU_FILE_TYPES = ['image', 'file', 'audio', 'media'] as const;

/** The files of a non-text message: `content` is the JSON the platform gives per type (`image_key`, or `file_key` and `file_name`). */
function feishuFiles(type: string, content: Record<string, unknown>): ChannelFile[] {
  if (type === 'image') return typeof content['image_key'] === 'string' ? [{ fileId: content['image_key'], name: 'image' }] : [];
  const key = content['file_key'];
  if (typeof key !== 'string') return [];
  const name = typeof content['file_name'] === 'string' && content['file_name'] !== '' ? content['file_name'] : type;
  return [{ fileId: key, name }];
}

export function feishuBaseUrl(domain: FeishuDomain | undefined): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
}

// ---- parser ----------------------------------------------------------------------------------------

const eventSchema = z.object({
  sender: z.object({
    sender_id: z.object({ open_id: z.string().optional() }).optional(),
    sender_type: z.string().optional(),
  }),
  message: z.object({
    message_id: z.string(),
    root_id: z.string().optional(),
    thread_id: z.string().optional(),
    chat_id: z.string(),
    chat_type: z.string(),
    message_type: z.string(),
    content: z.string(),
    mentions: z.array(z.object({ key: z.string(), name: z.string().optional(), id: z.object({ open_id: z.string().optional() }).optional() })).optional(),
  }),
});

/** The normalized event (same shape the CH1 ingress body carries). */
export type FeishuChannelEvent = ChannelInboundEvent;

export function parseFeishuMessage(event: unknown, botOpenId: string): FeishuChannelEvent | null {
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) return null;
  const { sender, message } = parsed.data;
  const fromId = sender.sender_id?.open_id;
  const isText = message.message_type === 'text';
  const isFile = (FEISHU_FILE_TYPES as readonly string[]).includes(message.message_type);
  if (!isText && !isFile || sender.sender_type === 'app' || fromId === undefined) return null;
  const chatType = message.chat_type === 'p2p' ? 'private' : message.chat_type === 'group' ? 'group' : null;
  if (chatType === null) return null;
  let text = '';
  let files: ChannelFile[] = [];
  try {
    const parsedContent: unknown = JSON.parse(message.content);
    const content = typeof parsedContent === 'object' && parsedContent !== null ? (parsedContent as Record<string, unknown>) : {};
    if (isText) {
      if (typeof content['text'] !== 'string') return null;
      text = content['text'];
    } else {
      files = feishuFiles(message.message_type, content);
      if (files.length === 0) return null;
    }
  } catch {
    return null;
  }
  if (chatType === 'group') {
    const botKeys = (message.mentions ?? []).filter((m) => m.id?.open_id === botOpenId).map((m) => m.key);
    if (botKeys.length === 0) return null;
    for (const key of botKeys) text = text.split(key).join('');
  }
  // Other people's `@_user_N` placeholders read as `@Name`. Feishu has no unique handle.
  const mentions: ChannelPerson[] = [];
  for (const mention of message.mentions ?? []) {
    const id = mention.id?.open_id;
    if (id === undefined || id === botOpenId || mention.name === undefined || mention.name === '') continue;
    text = text.split(mention.key).join('@' + mention.name);
    if (!mentions.some((seen) => seen.id === id)) mentions.push({ id, name: mention.name });
  }
  text = text.trim();
  if (text.length === 0 && files.length === 0) return null;
  const root = message.root_id ?? message.thread_id;
  return {
    chatId: message.chat_id,
    chatType,
    threadId: root === undefined || root === '' ? message.chat_id : message.chat_id + ':' + root,
    externalMessageId: message.message_id,
    from: { id: fromId, name: '' },
    text,
    ...(mentions.length === 0 ? {} : { mentions }),
    ...(files.length === 0 ? {} : { files }),
  };
}

// ---- API client ------------------------------------------------------------------------------------

export type FeishuCall<T> = { ok: true; data: T } | { ok: false; status: number; code?: number; error: string };

/** tenant_access_token codes: invalid / expired access token. */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991668]);
const REFRESH_MARGIN_MS = 5 * 60_000;

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();

export function clearFeishuTokenCache(): void {
  tokenCache.clear();
}

function cacheKey(creds: FeishuCredentials): string {
  return (creds.domain ?? 'feishu') + ':' + creds.appId;
}

async function request(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<FeishuCall<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const payload: unknown = await response.json().catch(() => null);
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const code = typeof record['code'] === 'number' ? record['code'] : undefined;
  // Feishu answers HTTP 200 with a non-zero `code` on errors.
  if (!response.ok || code !== 0) {
    const msg = record['msg'];
    return { ok: false, status: response.status, ...(code === undefined ? {} : { code }), error: typeof msg === 'string' ? msg : 'Feishu request failed' };
  }
  return { ok: true, data: record };
}

/** A tenant_access_token for the app: cached per app, refreshed within 5 minutes of expiry or when `force`. */
export async function getTenantToken(fetchFn: typeof fetch, creds: FeishuCredentials, force = false): Promise<FeishuCall<string>> {
  const key = cacheKey(creds);
  const cached = tokenCache.get(key);
  if (!force && cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return { ok: true, data: cached.token };
  const res = await request(fetchFn, feishuBaseUrl(creds.domain) + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  if (!res.ok) return res;
  const token = res.data['tenant_access_token'];
  const expire = res.data['expire'];
  if (typeof token !== 'string' || token.length === 0) return { ok: false, status: 400, error: 'No tenant_access_token returned' };
  tokenCache.set(key, { token, expiresAt: Date.now() + (typeof expire === 'number' ? expire : 7200) * 1000 });
  return { ok: true, data: token };
}

/** An authorized call; an invalid-token answer refreshes the token and retries once. */
export async function feishuCall(
  fetchFn: typeof fetch,
  creds: FeishuCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<FeishuCall<Record<string, unknown>>> {
  for (const force of [false, true]) {
    const token = await getTenantToken(fetchFn, creds, force);
    if (!token.ok) return token;
    const res = await request(fetchFn, feishuBaseUrl(creds.domain) + path, {
      method,
      headers: { authorization: 'Bearer ' + token.data, 'content-type': 'application/json; charset=utf-8' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.ok || res.code === undefined || !TOKEN_INVALID_CODES.has(res.code)) return res;
  }
  return { ok: false, status: 401, error: 'Feishu rejected the access token' };
}

export async function fetchFeishuBotInfo(
  fetchFn: typeof fetch,
  creds: FeishuCredentials,
): Promise<FeishuCall<{ openId: string; name: string }>> {
  const res = await feishuCall(fetchFn, creds, 'GET', '/open-apis/bot/v3/info');
  if (!res.ok) return res;
  const bot = res.data['bot'];
  const record = typeof bot === 'object' && bot !== null ? (bot as Record<string, unknown>) : {};
  const openId = record['open_id'];
  const name = record['app_name'];
  if (typeof openId !== 'string' || openId.length === 0) return { ok: false, status: 400, error: 'The app has no bot; enable the bot capability' };
  return { ok: true, data: { openId, name: typeof name === 'string' ? name : '' } };
}

/**
 * The open_id of the tenant member with this email (contact/v3/users/batch_get_id; needs the
 * contact:user.id:readonly scope), or undefined when there is none or the scope is missing.
 */
export async function lookupFeishuOpenIdByEmail(fetchFn: typeof fetch, creds: FeishuCredentials, email: string): Promise<string | undefined> {
  const res = await feishuCall(fetchFn, creds, 'POST', '/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id', { emails: [email] });
  if (!res.ok) return undefined;
  const data = res.data['data'];
  const list = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['user_list'] : undefined;
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    const id = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['user_id'] : undefined;
    if (typeof id === 'string' && id !== '') return id;
  }
  return undefined;
}

// ---- sender ----------------------------------------------------------------------------------------

export function createFeishuSender(fetchFn: typeof fetch = fetch): ChannelSender {
  async function send(target: ChannelSendTarget, msgType: 'text' | 'interactive', content: string): Promise<ChannelSendResult> {
    const channel = target.channel;
    const creds: FeishuCredentials = { appId: channel.channelId, appSecret: channel.botToken ?? '', ...(channel.domain === undefined ? {} : { domain: channel.domain }) };
    const sep = target.threadId.indexOf(':');
    const root = sep === -1 ? undefined : target.threadId.slice(sep + 1);
    const res = root === undefined
      ? await feishuCall(fetchFn, creds, 'POST', '/open-apis/im/v1/messages?receive_id_type=chat_id', { receive_id: target.chatId, msg_type: msgType, content })
      : await feishuCall(fetchFn, creds, 'POST', '/open-apis/im/v1/messages/' + encodeURIComponent(root) + '/reply', { msg_type: msgType, content });
    if (!res.ok) return { ok: false, error: 'Feishu send failed: ' + String(res.code ?? res.status) + ' ' + res.error };
    const data = res.data['data'];
    const id = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['message_id'] : undefined;
    return typeof id === 'string' ? { ok: true, externalId: id } : { ok: true };
  }
  return {
    sendText: (target, text) => send(target, 'text', JSON.stringify({ text: renderMentions(text, (person) => '<at user_id="' + person.id + '">' + person.name + '</at>') })),
    sendRich: (target, rich: RichMessage) => send(target, 'interactive', JSON.stringify(feishuCard(rich))),
  };
}
