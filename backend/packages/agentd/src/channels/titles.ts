/**
 * Display titles for the conversations a platform opens on its own (group chats, strangers' private chats): "#general · Slack".
 * Looked up once when the conversation is created; any failure falls back to a generic name instead of blocking the message.
 */
import type { ChannelRow, Store } from '@agent-desktop/contracts';
import { openChannelRow } from './credentials.js';
import type { ChannelRegistry } from './registry.js';

interface TitleEvent {
  chatType: 'private' | 'group';
  chatId?: string;
  chatTitle?: string;
  from?: { name?: string };
}

/** "Telegram · Nova": the owner's private chat with an agent on a platform. */
export function ownerChatTitle(channels: ChannelRegistry, channel: ChannelRow, agentName: string): string {
  return channels.displayName(channel) + ' · ' + agentName;
}

export async function chatTitleFor(deps: { store: Store; channels: ChannelRegistry; channelFetch?: typeof fetch }, channel: ChannelRow, event: TitleEvent): Promise<string | undefined> {
  const platform = deps.channels.displayName(channel);
  if (event.chatType === 'private') {
    const who = event.from?.name?.trim();
    return who ? who + ' · ' + platform : undefined;
  }
  let name = event.chatTitle?.trim() || undefined;
  const lookup = deps.channels.get(channel.kind)?.adapter.identity.chatName;
  if (name === undefined && event.chatId !== undefined && lookup !== undefined) {
    const opened = await openChannelRow(deps.store, channel);
    const token = 'error' in opened ? undefined : opened.channel.botToken;
    if (token !== undefined) name = await lookup(deps.channelFetch ?? fetch, token, event.chatId);
  }
  return (name ?? 'Group chat') + ' · ' + platform;
}
