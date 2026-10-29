/**
 * The channel SDK: one chat platform is one `ChannelAdapter`. Everything platform-specific that agentd's core needs to know is a
 * member of it, so core code never branches on a platform name (see docs/BACKEND.md "聊天平台 = 一个插件"):
 *  - `capabilities`: what the agent can do in a chat of this platform, given the optional permissions the app was granted;
 *  - `identity`: names, ids and credentials (identity.ts);
 *  - `transport`: how messages reach the platform (outbound sender, with its group reply planner);
 *  - `abilities`: react / history / attachment / sendFile (abilities.ts), each answering `unsupported` when the platform lacks it.
 * agentd's platform plugin (one per platform, agentd/src/channels/<platform>/plugin.ts) registers the adapter with the plugin host
 * under its kind and adds what needs the store (connector, runners, webhook). Nothing here registers or lists platforms.
 */
import type { ChatCapabilities } from '@agent-desktop/public-contracts';
import type { ChannelAbilities } from './abilities.js';
import type { ParsedClick } from './click.js';
import { discordAbilities, discordCapabilities } from './discord/abilities.js';
import { createDiscordSender } from './discord/api.js';
import { parseDiscordClick } from './discord/click.js';
import { parseFeishuClick } from './feishu/click.js';
import { parseSlackClick } from './slack/click.js';
import { parseTelegramClick } from './telegram/click.js';
import { discordChannelName } from './discord/titles.js';
import { createFeishuSender } from './feishu/api.js';
import { feishuAbilities, feishuCapabilities } from './feishu/abilities.js';
import { platformIdentity, type ChannelIdentity } from './identity.js';
import { discordReplyPlanner, slackReplyPlanner, telegramReplyPlanner } from './outbound.js';
import { createSlackSender } from './slack/send.js';
import { slackAbilities, slackCapabilities } from './slack/abilities.js';
import { slackChannelName } from './slack/titles.js';
import { telegramAbilities, telegramCapabilities } from './telegram/abilities.js';
import { createTelegramSender } from './telegram/send.js';
import type { ChannelSender } from './types.js';

/** The communication layer: how messages reach the platform. */
export interface ChannelTransport {
  /** The outbound sender (send text or a rich message, return the platform message id); `fetchFn` is injected for tests. */
  sender(fetchFn?: typeof fetch): ChannelSender;
}

export interface ChannelAdapter {
  /** What a chat of this platform can do; `grants` are the optional platform permissions the connected app was given. */
  capabilities(grants: readonly string[]): ChatCapabilities;
  identity: ChannelIdentity;
  /** Receiving: a button tap in the platform's own payload as a neutral click that can answer itself (click.ts); undefined: not a tap of ours. */
  inbound: { parseClick(raw: unknown): ParsedClick | undefined };
  transport: ChannelTransport;
  abilities: ChannelAbilities;
}

export const telegramAdapter: ChannelAdapter = {
  capabilities: telegramCapabilities,
  identity: platformIdentity('Telegram', {
    // A Telegram mention names the bot by its username, which is the channel id.
    addressesSelf: (row, person) => (row.botUserId !== undefined && person.id === row.botUserId) || person.handle === row.channelId,
    botLabel: (row) => '@' + row.channelId,
  }),
  inbound: { parseClick: parseTelegramClick },
  transport: { sender: (fetchFn = fetch) => ({ ...createTelegramSender(fetchFn), planReply: telegramReplyPlanner }) },
  abilities: telegramAbilities,
};

export const slackAdapter: ChannelAdapter = {
  capabilities: slackCapabilities,
  identity: platformIdentity('Slack', {
    // A message ts is only unique inside its channel.
    externalMessageKey: (chatId, messageId) => chatId + ':' + messageId,
    // A Slack user id is only unique inside its workspace.
    workspaceOf: (row) => row.teamId ?? '',
    chatName: slackChannelName,
  }),
  inbound: { parseClick: parseSlackClick },
  transport: { sender: (fetchFn = fetch) => ({ ...createSlackSender(fetchFn), planReply: slackReplyPlanner(fetchFn) }) },
  abilities: slackAbilities,
};

export const feishuAdapter: ChannelAdapter = {
  capabilities: feishuCapabilities,
  identity: platformIdentity('Feishu', {
    displayName: (row) => (row.domain === 'lark' ? 'Lark' : 'Feishu'),
    // The app id is the channel id and the app secret is the token.
    authOf: (row) => ({ token: row.botToken ?? '', appId: row.channelId, ...(row.domain === undefined ? {} : { domain: row.domain }) }),
  }),
  inbound: { parseClick: parseFeishuClick },
  transport: { sender: createFeishuSender },
  abilities: feishuAbilities,
};

export const discordAdapter: ChannelAdapter = {
  capabilities: discordCapabilities,
  identity: platformIdentity('Discord', { chatName: discordChannelName }),
  inbound: { parseClick: parseDiscordClick },
  transport: { sender: (fetchFn = fetch) => ({ ...createDiscordSender(fetchFn), planReply: discordReplyPlanner(fetchFn) }) },
  abilities: discordAbilities,
};
