import { connectorsBuiltinPlugin } from '../connectors/plugin.js';
import { discordPlugin } from '../channels/discord/plugin.js';
import { feishuPlugin } from '../channels/feishu/plugin.js';
import { slackPlugin } from '../channels/slack/plugin.js';
import { telegramPlugin } from '../channels/telegram/plugin.js';
import { meetingsPlugin } from '../meetings/plugin.js';
import { monitorsPlugin } from '../monitors/plugin.js';
import type { AgentdPlugin } from './services.js';

/** The chat platforms: one plugin each, named by the platform kind. Turn one off with `JUNO_PLUGINS={"discord":{"enabled":false}}`. */
export const channelPlugins: readonly AgentdPlugin[] = [telegramPlugin, slackPlugin, discordPlugin, feishuPlugin];

/** The first-party plugins agentd runs. Adding a feature as a plugin means adding it here. */
export const builtinPlugins: readonly AgentdPlugin[] = [...channelPlugins, meetingsPlugin, monitorsPlugin, connectorsBuiltinPlugin];
