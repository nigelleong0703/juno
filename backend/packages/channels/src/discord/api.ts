/**
 * Discord adapter pieces: the MESSAGE_CREATE parser, a thin REST helper and the reply sender.
 *
 * Receiving uses the Gateway without the privileged MESSAGE_CONTENT intent: DMs, @mentions of the bot and
 * replies to the bot still carry their text, so the parser keeps exactly those and drops the rest. Discord
 * threads are channels of their own, so `channel_id` is both chat and thread id and task-per-thread falls
 * out of the existing conversation derivation. Error text never carries the bot token.
 */
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '@agent-desktop/contracts/secrets';
import type { ChannelFile, ChannelInboundEvent, ChannelPerson, ChannelSender, ChannelSendResult, ChannelSendTarget } from '../types.js';
import { renderMentions } from '../mentions.js';
import { discordMessages } from './render.js';
import type { RichMessage } from '../render.js';

export const DISCORD_API = 'https://discord.com/api/v10';

/** Discord rejects a message body longer than this. */
export const DISCORD_MESSAGE_LIMIT = 2000;

const messageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  webhook_id: z.string().optional(),
  content: z.string().default(''),
  /** Files of the message; `url` is the CDN address the bytes are read from. */
  attachments: z.array(z.object({ id: z.string(), filename: z.string(), content_type: z.string().optional(), size: z.number().optional(), url: z.string() })).default([]),
  author: z.object({
    id: z.string(),
    username: z.string().optional(),
    global_name: z.string().nullish(),
    bot: z.boolean().optional(),
  }),
  mentions: z.array(discordUserSchema()).default([]),
  referenced_message: z.object({ author: z.object({ id: z.string() }) }).nullish(),
});

/** The normalized event (same shape the CH1 ingress body carries). */
export type DiscordChannelEvent = ChannelInboundEvent;

/** A user object of a message's `mentions` array: `member.nick` is only there in a server. */
export function discordUserSchema() {
  return z.object({ id: z.string(), username: z.string().optional(), global_name: z.string().nullish(), member: z.object({ nick: z.string().nullish() }).nullish() });
}

export function discordPerson(user: z.infer<ReturnType<typeof discordUserSchema>>): ChannelPerson {
  return { id: user.id, name: user.member?.nick ?? user.global_name ?? user.username ?? user.id, ...(user.username === undefined ? {} : { handle: user.username }) };
}

/** `<@id>` / `<@!id>` of every mentioned user but `skipId` (the agent's own bot, stripped elsewhere) become `@Name`; `<#channel>` stays. */
export function rewriteDiscordMentions(text: string, users: Array<z.infer<ReturnType<typeof discordUserSchema>>>, skipId: string): { text: string; mentions: ChannelPerson[] } {
  const mentions: ChannelPerson[] = [];
  let out = text;
  for (const user of users) {
    if (user.id === skipId || mentions.some((seen) => seen.id === user.id)) continue;
    const person = discordPerson(user);
    mentions.push(person);
    out = out.split('<@' + user.id + '>').join('@' + person.name).split('<@!' + user.id + '>').join('@' + person.name);
  }
  return { text: out, mentions };
}

/** `<@&id>` role mentions read `@Name` for a role we know (an agent's, `names`: role id to name), else `@role`; never the raw tag. */
export function rewriteDiscordRoles(text: string, names: ReadonlyMap<string, string> = new Map()): string {
  return text.replace(/<@&([^>\s]+)>/g, (_whole, id: string) => '@' + (names.get(id) ?? 'role'));
}

export function parseDiscordMessage(message: unknown, botUserId: string): DiscordChannelEvent | null {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) return null;
  const msg = parsed.data;
  if (msg.author.bot === true || msg.webhook_id !== undefined || msg.author.id === botUserId) return null;
  const isGuild = msg.guild_id !== undefined;
  let text = msg.content;
  if (isGuild) {
    const mentioned = msg.mentions.some((user) => user.id === botUserId);
    const repliesToBot = msg.referenced_message?.author.id === botUserId;
    if (!mentioned && !repliesToBot) return null;
    text = text.split('<@' + botUserId + '>').join('').split('<@!' + botUserId + '>').join('');
  }
  const rewritten = rewriteDiscordMentions(text, msg.mentions, botUserId);
  text = rewritten.text.trim();
  const files: ChannelFile[] = msg.attachments.map((file) => ({ fileId: file.url, name: file.filename, ...(file.content_type === undefined ? {} : { mimeType: file.content_type }), ...(file.size === undefined ? {} : { sizeBytes: file.size }) }));
  if (text.length === 0 && files.length === 0) return null;
  return {
    chatId: msg.channel_id,
    chatType: isGuild ? 'group' : 'private',
    threadId: msg.channel_id,
    externalMessageId: msg.id,
    from: { id: msg.author.id, name: msg.author.global_name ?? msg.author.username ?? '', ...(msg.author.username === undefined ? {} : { handle: msg.author.username }) },
    text,
    ...(rewritten.mentions.length === 0 ? {} : { mentions: rewritten.mentions }),
    ...(files.length === 0 ? {} : { files }),
  };
}

/** Our own app: the bot user and the install's webhooks (the agents' voices). */
export interface DiscordOurs {
  botUserId?: string;
  webhookIds: ReadonlySet<string>;
}

/** Did anyone but our own app post after this message? (One cheap lookup; undefined when Discord does not say.) */
export async function discordOthersAfter(fetchFn: typeof fetch, token: string, chatId: string, afterId: string, ours: DiscordOurs): Promise<boolean | undefined> {
  const res = await discordCall(fetchFn, token, 'GET', '/channels/' + chatId + '/messages?after=' + afterId + '&limit=10');
  if (!res.ok || !Array.isArray(res.body)) return undefined;
  return res.body.some((raw) => {
    const msg = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const author = typeof msg['author'] === 'object' && msg['author'] !== null ? (msg['author'] as Record<string, unknown>) : {};
    const webhookId = msg['webhook_id'];
    return !(author['id'] === ours.botUserId || (typeof webhookId === 'string' && ours.webhookIds.has(webhookId)));
  });
}

export type DiscordCall = { ok: true; body: unknown } | { ok: false; status: number; error: string; retryAfter?: number };

/** One authenticated REST call. A transport failure is status 0; Discord's refusals keep their HTTP status. */
export async function discordCall(
  fetchFn: typeof fetch,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<DiscordCall> {
  let response: Response;
  try {
    response = await fetchFn(DISCORD_API + path, {
      method,
      headers: { authorization: 'Bot ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const payload: unknown = await response.json().catch(() => null);
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  if (!response.ok) {
    const message = record['message'];
    const retry = record['retry_after'];
    return {
      ok: false,
      status: response.status,
      error: typeof message === 'string' ? message : 'Discord ' + path + ' failed',
      ...(typeof retry === 'number' ? { retryAfter: retry } : {}),
    };
  }
  return { ok: true, body: payload };
}

/** Split into chunks of at most `limit` UTF-16 units without cutting a surrogate pair. */
export function chunkMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Speak as the agent in a server channel of the shared bot: the channel's webhook (created on first use, its token sealed on the
 * installation) with the agent's `username` / `avatar_url`. Returns undefined when that is not possible (a DM, a thread, no
 * permission, a deleted webhook) so the caller falls back to a plain bot message.
 */
async function sendViaWebhook(fetchFn: typeof fetch, target: ChannelSendTarget, bodies: Array<Record<string, unknown>>): Promise<ChannelSendResult | undefined> {
  const { installation, identity } = target;
  if (installation === undefined || identity === undefined || target.chatType === 'private') return undefined;
  let hook = installation.webhooks?.[target.chatId];
  let token: string;
  let id: string;
  if (hook === undefined) {
    const created = await discordCall(fetchFn, target.channel.botToken ?? '', 'POST', '/channels/' + target.chatId + '/webhooks', { name: 'Juno' });
    const record = created.ok && typeof created.body === 'object' && created.body !== null ? (created.body as Record<string, unknown>) : {};
    if (typeof record['id'] !== 'string' || typeof record['token'] !== 'string') return undefined;
    id = record['id'];
    token = record['token'];
    hook = { id, token: encryptSecret(token) };
    await target.persistInstallation?.({ webhooks: { ...installation.webhooks, [target.chatId]: hook } });
  } else {
    id = hook.id;
    token = decryptSecret(hook.token);
  }
  // A webhook message cannot carry a message_reference, so a reply to the message that addressed the agent opens with a subtext line linking it.
  const line = replyLine(target, installation.teamId);
  if (line !== undefined) {
    const first = bodies[0];
    const content = typeof first?.['content'] === 'string' ? first['content'] : '';
    if (first !== undefined && line.length + 1 + content.length <= DISCORD_MESSAGE_LIMIT) bodies = [{ ...first, content: line + '\n' + content }, ...bodies.slice(1)];
    else bodies = [{ content: line }, ...bodies];
  }
  const ids: string[] = [];
  for (const body of bodies) {
    let response: Response;
    try {
      response = await fetchFn(DISCORD_API + '/webhooks/' + id + '/' + token + '?wait=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, username: identity.name.slice(0, 80), ...(identity.iconUrl === undefined ? {} : { avatar_url: identity.iconUrl }) }),
      });
    } catch {
      return undefined;
    }
    if (response.status === 404 || response.status === 401) {
      // The webhook was deleted in Discord: forget it, this message goes out as the bot and the next one makes a fresh webhook.
      const { [target.chatId]: _gone, ...rest } = installation.webhooks ?? {};
      await target.persistInstallation?.({ webhooks: rest });
      return undefined;
    }
    if (!response.ok) return { ok: false, error: 'Discord send failed: ' + String(response.status) };
    const payload: unknown = await response.json().catch(() => null);
    const sent = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['id'] : undefined;
    if (typeof sent === 'string') ids.push(sent);
  }
  return sentResult(ids);
}

function sentResult(ids: string[]): ChannelSendResult {
  const [first] = ids;
  return first === undefined ? { ok: true } : { ok: true, externalId: first, externalIds: ids };
}

/** `-# ↪ replying to <@asker> · <link>`: Discord's subtext line standing in for the reply arrow a webhook cannot draw. */
export function replyLine(target: ChannelSendTarget, guildId: string): string | undefined {
  if (target.replyToMessageId === undefined) return undefined;
  const who = target.replyToUserId === undefined ? '' : ' to <@' + target.replyToUserId + '>';
  return '-# ↪ replying' + who + ' · https://discord.com/channels/' + guildId + '/' + target.chatId + '/' + target.replyToMessageId;
}

/** Thread the first message under the one that addressed the agent. */
function discordReference(target: ChannelSendTarget): Record<string, unknown> {
  return target.replyToMessageId === undefined ? {} : { message_reference: { message_id: target.replyToMessageId, fail_if_not_exists: false } };
}

/** Discord REST sender: `POST /channels/{chatId}/messages`, long replies in 2000-char chunks. */
export function createDiscordSender(fetchFn: typeof fetch = fetch): ChannelSender {
  return {
    async sendText(target, rawText): Promise<ChannelSendResult> {
      const text = renderMentions(rawText, (person) => '<@' + person.id + '>');
      const hooked = await sendViaWebhook(fetchFn, target, chunkMessage(text).map((content) => ({ content })));
      if (hooked !== undefined) return hooked;
      const token = target.channel.botToken ?? '';
      const ids: string[] = [];
      for (const content of chunkMessage(text)) {
        const res = await discordCall(fetchFn, token, 'POST', '/channels/' + target.chatId + '/messages', { content, ...(ids.length === 0 ? discordReference(target) : {}) });
        if (!res.ok) {
          const retry = res.retryAfter === undefined ? '' : ' (retry_after ' + String(res.retryAfter) + 's)';
          return { ok: false, error: 'Discord send failed: ' + String(res.status) + ' ' + res.error + retry };
        }
        const id = typeof res.body === 'object' && res.body !== null ? (res.body as Record<string, unknown>)['id'] : undefined;
        if (typeof id === 'string') ids.push(id);
      }
      return sentResult(ids);
    },
    async sendRich(target, rich: RichMessage): Promise<ChannelSendResult> {
      const hooked = await sendViaWebhook(fetchFn, target, discordMessages(rich));
      if (hooked !== undefined) return hooked;
      const token = target.channel.botToken ?? '';
      const ids: string[] = [];
      for (const message of discordMessages(rich)) {
        const res = await discordCall(fetchFn, token, 'POST', '/channels/' + target.chatId + '/messages', { ...message, ...(ids.length === 0 ? discordReference(target) : {}) });
        if (!res.ok) return { ok: false, error: 'Discord send failed: ' + String(res.status) + ' ' + res.error };
        const id = typeof res.body === 'object' && res.body !== null ? (res.body as Record<string, unknown>)['id'] : undefined;
        if (typeof id === 'string') ids.push(id);
      }
      return sentResult(ids);
    },
  };
}
