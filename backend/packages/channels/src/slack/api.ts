/**
 * Slack adapter pieces (CH3): the Events API parser (the sender is in send.ts).
 *
 * `parseSlackEvent` turns a raw `event_callback` body into the normalized channel event the ingress
 * admits, or null when the agent should not hear it (edits and other subtypes, bot-authored messages,
 * the bot's own user, channel chatter that does not mention the bot). Request signing is verified at
 * the api before the body gets here.
 */
import { z } from 'zod';
import type { ChannelFile, ChannelInboundEvent, ChannelSendTarget } from '../types.js';

const fileSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  mimetype: z.string().optional(),
  size: z.number().optional(),
  url_private: z.string().optional(),
});

const eventSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  channel: z.string().optional(),
  channel_type: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  files: z.array(fileSchema).optional(),
});

/** The files of a message (`files`, on a file_share message or a mention that carries one). `fileId` is the file's `url_private`, which the attachment call downloads with the bot token. */
export function slackFiles(files: unknown): ChannelFile[] {
  const parsed = z.array(fileSchema).safeParse(files);
  if (!parsed.success) return [];
  return parsed.data.flatMap((file): ChannelFile[] => file.url_private === undefined
    ? []
    : [{ fileId: file.url_private, name: file.name ?? file.id, ...(file.mimetype === undefined ? {} : { mimeType: file.mimetype }), ...(file.size === undefined ? {} : { sizeBytes: file.size }) }]);
}

const envelopeSchema = z.object({ type: z.string(), event: eventSchema.optional() });

/** `text` still holds `<@U…>` mentions of other people: `resolveSlackMentions` (slack/mentions.ts) needs a lookup, so the caller applies it. */
export type SlackChannelEvent = ChannelInboundEvent;


export function parseSlackEvent(body: unknown, botUserId: string): SlackChannelEvent | null {
  const parsed = envelopeSchema.safeParse(body);
  const event = parsed.success && parsed.data.type === 'event_callback' ? parsed.data.event : undefined;
  // A file_share message is a message with files attached (its text may be empty); every other subtype is not the agent's business.
  if (!event || (event.subtype !== undefined && event.subtype !== 'file_share') || event.bot_id !== undefined) return null;
  if (event.channel === undefined || event.user === undefined || event.ts === undefined || event.text === undefined) return null;
  if (event.user === botUserId) return null;
  const isDm = event.type === 'message' && event.channel_type === 'im';
  if (!isDm && event.type !== 'app_mention') return null;
  const text = isDm ? event.text.trim() : event.text.split('<@' + botUserId + '>').join('').trim();
  const files = slackFiles(event.files);
  if (text.length === 0 && files.length === 0) return null;
  const threadTs = event.thread_ts ?? (isDm ? undefined : event.ts);
  return {
    chatId: event.channel,
    chatType: isDm ? 'private' : 'group',
    threadId: threadTs === undefined ? event.channel : event.channel + ':' + threadTs,
    externalMessageId: event.channel + ':' + event.ts,
    from: { id: event.user, name: '' },
    text,
    ...(files.length === 0 ? {} : { files }),
  };
}

/** The agent's own name and picture on a shared app's message (needs chat:write.customize). */
export function slackIdentity(target: ChannelSendTarget): { username?: string; icon_url?: string } {
  return target.identity === undefined ? {} : { username: target.identity.name, ...(target.identity.iconUrl === undefined ? {} : { icon_url: target.identity.iconUrl }) };
}
