/**
 * The seam between agentd and the platforms. This package is pure platform I/O: inputs are tokens, ids and payloads plus an injected
 * `fetch`, outputs are normalized data. It knows nothing of the store, the routes or the agent runtime.
 *
 * An adapter (the pattern of the Vercel Chat SDK adapters) has three parts: parse an inbound platform payload into the normalized
 * event, send a reply and return the platform message id, and fetch the chat history before a message, oldest first.
 */
import type { ChannelInstallation, ChannelRow } from '@agent-desktop/contracts';
import type { ChannelOrigin } from '@agent-desktop/public-contracts';
import type { RichMessage } from './render.js';

/** The name and picture an agent speaks with on a shared app (Slack `username` / `icon_url`, Discord webhook `username` / `avatar_url`). */
export interface SenderIdentity {
  name: string;
  iconUrl?: string;
}

/** Where one reply goes. `channel` is the stored row with its credentials already opened (never sealed). */
export interface ChannelSendTarget {
  channel: ChannelRow;
  chatId: string;
  threadId: string;
  /** Private chat or group channel; a shared Discord bot answers a DM as itself and a server channel through a webhook. */
  chatType?: 'private' | 'group';
  /** Group chat: the platform message this reply answers; the sender posts it as a reply to it (Telegram, Discord). */
  replyToMessageId?: string;
  /** The platform user whose message this reply answers (Discord names them in the reply line of a webhook post). */
  replyToUserId?: string;  /** Shared Slack app / Discord bot: the agent's own name and picture on the message. */
  identity?: SenderIdentity;
  /** The shared install behind `channel` (workspace / server), with a way to save what the sender learns (Discord webhooks). */
  installation?: ChannelInstallation;
  persistInstallation?(patch: Partial<ChannelInstallation>): Promise<void>;
}

/** What a group reply needs before it is sent: whether to quote the message that addressed the agent, and who it may mention. */
export interface ReplyPlan {
  quote: boolean;
  people: ChannelPerson[];
}

/** `externalId` is the first message sent; `externalIds` is every message it was split into (Discord agent-to-agent mentions look them up). */
export type ChannelSendResult = { ok: true; externalId?: string; externalIds?: string[] } | { ok: false; error: string };

export interface ChannelSender {
  sendText(target: ChannelSendTarget, text: string): Promise<ChannelSendResult>;
  /** Formatted text with buttons for the platform; a sender without it gets `plainText(rich)` through sendText. */
  sendRich?(target: ChannelSendTarget, rich: RichMessage): Promise<ChannelSendResult>;
  /** Group reply: quote or not, and the people it may mention (see outbound.ts). Absent: no quote, no mentions. */
  planReply?(token: string, origin: ChannelOrigin, replyText: string, ours: { botUserId?: string; webhookIds: ReadonlySet<string> }): Promise<ReplyPlan>;
}

/**
 * A person on a platform. `id` is the only thing identity is decided by; `name` is a display name (anyone can rename themselves
 * to someone else's); `handle` is the platform's unique, stable username when it has one (Discord, Telegram).
 */
export interface ChannelPerson {
  id: string;
  name: string;
  handle?: string;
}

/**
 * What every platform's inbound parser produces (and the ingress body carries). `text` has each platform mention of another person
 * rewritten to `@Name`, listed in `mentions`; the agent's own mention is stripped. The agent runtime never sees platform syntax.
 */
export interface ChannelInboundEvent {
  chatId: string;
  chatType: 'private' | 'group';
  threadId: string;
  externalMessageId: string;
  from: ChannelPerson;
  text: string;
  mentions?: ChannelPerson[];
  /** Files the message carries; each is fetched with the platform's `attachment` call (see abilities.ts). */
  files?: ChannelFile[];
  /** A group with people from another workspace or tenant (Slack Connect, a Feishu external group). Absent: not known. */
  external?: boolean;
}

/** A file a platform message carries. `fileId` is what the platform's `attachment` call takes: Telegram's file_id, Slack's url_private, Discord's CDN url, Feishu's file_key / image_key. */
export interface ChannelFile {
  fileId: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** How many messages a history fetcher asks the platform for; a result of exactly this size may have older messages behind it. */
export const HISTORY_FETCH_LIMIT = 30;

/** One message of a chat's history, whatever the platform. `webhookId` is Discord's: set when a webhook (an agent's voice) posted it. */
export interface ChannelMessage {
  id: string;
  at: string;
  text: string;
  author: ChannelPerson & { isBot: boolean; webhookId?: string };
  /** The people the message mentions (its text already reads `@Name`). */
  mentions?: ChannelPerson[];
}

/**
 * What a platform adapter offers agentd, as plain functions per platform folder: `parse*` (inbound payload to the normalized event),
 * `create*Sender` (a ChannelSender, whose send returns the platform message id) and a history fetcher of this shape.
 * `beforeId` is the platform id of the message that woke the agent (absent: the chat's latest messages); the result is oldest first,
 * undefined when the platform cannot say. `roleNames` (Discord): role id to the agent it names, so a role mention reads `@Name`.
 */
export type HistoryFetcher = (
  fetchFn: typeof fetch,
  token: string,
  chat: HistoryRequest,
) => Promise<ChannelMessage[] | undefined>;

/**
 * Which messages a history fetch asks for: the ones before `beforeId` (a platform message id) or `beforeAt` (an ISO time; wins when
 * both are given), `limit` of them (default HISTORY_FETCH_LIMIT). With neither, the chat's newest.
 */
export interface HistoryRequest {
  chatId: string;
  threadId: string;
  beforeId?: string;
  beforeAt?: string;
  limit?: number;
  roleNames?: ReadonlyMap<string, string>;
}
