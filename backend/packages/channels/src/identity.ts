/**
 * What agentd's core needs to know about a platform's identities and ids, so it never branches on a platform name: how the platform is
 * called, whether a mentioned person is the channel's own bot, how a platform message id is stored, which workspace an account lives
 * in, what the bot is called to the owner, how a group's name is looked up and what a call is made with. Defaults suit most
 * platforms; a platform overrides what differs (`platformIdentity`).
 */
import type { ChannelRow } from '@agent-desktop/contracts';
import type { AdapterAuth } from './abilities.js';

export interface ChannelIdentity {
  /** The platform's name for people ("Slack"; Feishu on the Lark domain: "Lark"). */
  displayName(row: Pick<ChannelRow, 'domain'>): string;
  /** Whether a person mentioned in a group message is this channel's own bot. */
  addressesSelf(row: Pick<ChannelRow, 'botUserId' | 'channelId'>, person: { id: string; handle?: string }): boolean;
  /** The platform's message id as the channel ingress stores it (`externalMessageId`). */
  externalMessageKey(chatId: string, messageId: string): string;
  /** The workspace an account lives in; '' when the platform's user ids are global. */
  workspaceOf(row: Pick<ChannelRow, 'teamId'>): string;
  /** What the owner is told the bot is called ("Is this you?" prompts). */
  botLabel(row: Pick<ChannelRow, 'channelId'>, agentName: string): string;
  /** A group's display name when the event has none; absent: the platform has no lookup. */
  chatName?(fetchFn: typeof fetch, token: string, chatId: string): Promise<string | undefined>;
  /** What a platform call is made with, from a row whose credentials are open. */
  authOf(row: ChannelRow): AdapterAuth;
}

export function platformIdentity(name: string, overrides: Partial<ChannelIdentity> = {}): ChannelIdentity {
  return {
    displayName: () => name,
    addressesSelf: (row, person) => row.botUserId !== undefined && person.id === row.botUserId,
    externalMessageKey: (_chatId, messageId) => messageId,
    workspaceOf: () => '',
    botLabel: (_row, agentName) => agentName,
    authOf: (row) => ({ token: row.botToken ?? '' }),
    ...overrides,
  };
}
