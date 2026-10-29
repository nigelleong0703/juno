/**
 * A chat platform is two layers (and later one plugin providing both):
 *   1. the communication layer (`ChannelTransport` in platform.ts): connect / install / identity binding, receiving inbound messages
 *      into the normalized shape, sending outbound ones. Today: `create*Sender`, `parse*` and agentd's connectors and runners.
 *   2. the capability layer (this file): what the agent can DO in a chat beyond sending text. `ChannelAbilities`, one per platform
 *      (`<platform>/abilities.ts`), plus the declared table `CHAT_CAPABILITIES` / `chatCapabilities()` in public-contracts.
 * Like the rest of this package it is pure platform I/O: credentials, ids and an injected `fetch` in, a result out; no store, no
 * agent runtime.
 *
 * Default: everything is possible, and a platform declares only what it cannot do. An ability it has not implemented answers
 * `unsupported` (`NOT_YET` below), which the agent reads as "not available here", never as an error. The tools check the table
 * first, the abilities do the calls.
 */
import { plainEmoji } from '@agent-desktop/public-contracts';
import type { ChannelMessage, HistoryRequest } from './types.js';

/**
 * `unsupported`: this platform has no such call (or the adapter does not implement it yet). `skipped`: it could, but not for this
 * input (an emoji the platform's reaction set does not have). `failed`: the platform refused or was unreachable.
 */
export type AdapterResult<T = undefined> =
  | { status: 'ok'; value: T }
  | { status: 'unsupported' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

/** What a platform call is made with: the bot token (Feishu: the app secret, with `appId` and `domain`). */
export interface AdapterAuth {
  token: string;
  appId?: string;
  domain?: 'feishu' | 'lark';
}

/** One message of a chat, by the platform's own ids. */
export interface MessageRef {
  chatId: string;
  messageId: string;
}

/** A file to post: the bytes and what they are. */
export interface LocalFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ChannelAbilities {
  /** Put an emoji reaction on a message. `reactionId` (Feishu) is what removing it needs. */
  react(fetchFn: typeof fetch, auth: AdapterAuth, message: MessageRef, emoji: string): Promise<AdapterResult<{ reactionId?: string }>>;
  /** Take the agent's own reaction back off. */
  unreact(fetchFn: typeof fetch, auth: AdapterAuth, message: MessageRef, emoji: string, reactionId?: string): Promise<AdapterResult>;
  /** Earlier messages of a chat, oldest first. */
  history(fetchFn: typeof fetch, auth: AdapterAuth, chat: HistoryRequest): Promise<AdapterResult<ChannelMessage[]>>;
  /** The bytes of a file someone posted. */
  attachment(fetchFn: typeof fetch, auth: AdapterAuth, file: { messageId: string; fileId: string }): Promise<AdapterResult<{ bytes: Uint8Array; mime?: string }>>;
  /** Post a file into a chat. */
  sendFile(fetchFn: typeof fetch, auth: AdapterAuth, chat: { chatId: string; threadId: string }, file: LocalFile, caption?: string): Promise<AdapterResult<{ messageId?: string }>>;
}

/** The platform's name for an emoji (Slack `+1`, Feishu `THUMBSUP`) from one of the reaction maps, or undefined when the platform has none. */
export function platformEmoji(names: Readonly<Record<string, string>>, emoji: string): string | undefined {
  const wanted = plainEmoji(emoji);
  return Object.entries(names).find(([key]) => plainEmoji(key) === wanted)?.[1];
}

/** The result for an emoji a platform's reaction set does not have. */
export function emojiSkipped(platform: string, emoji: string): { status: 'skipped'; reason: string } {
  return { status: 'skipped', reason: platform + ' has no ' + emoji + ' reaction' };
}

async function unsupported(): Promise<{ status: 'unsupported' }> {
  return { status: 'unsupported' };
}

/** The methods no platform implements yet (file bytes in and out); a platform spreads this and overrides what it has. */
export const NOT_YET = { unreact: unsupported, attachment: unsupported, sendFile: unsupported };

/** The abilities of a platform that does nothing beyond text. */
export const TEXT_ONLY: ChannelAbilities ={ react: unsupported, history: unsupported, ...NOT_YET };
