/**
 * The Discord plugin: the whole platform behind one registration (see registration.ts for the two layers).
 *  - communication layer: the connector (own bot / shared Juno bot), the two gateway runners (own bots and the shared bot, text and
 *    voice), outbound via packages/channels `discordAdapter.transport` with the Discord delivery hooks (delivery.ts: role mentions,
 *    sent-message records); Discord events arrive over the gateway, not a webhook;
 *  - capability layer: `discordAdapter.abilities` (reactions, history: a group mention brings the messages before it);
 *  - voice: the sessions (voice.ts) this plugin owns, offered to agents through the voice tools;
 *  - route: the shared bot's invite redirect (`/v1/channels/discord/oauth/callback`), mounted through `ctx.http.route`.
 */
import { discordAdapter } from '@agent-desktop/channels/sdk';
import { createTranscriber } from 'juno-agent/modules/transcription';
import type { AgentdPlugin } from '../../plugins/services.js';
import type { ChannelRegistration } from '../registration.js';
import { discordConnector } from './connect.js';
import { createSharedDiscordGateway } from './gateway.js';
import { discordDelivery } from './delivery.js';
import { completeSharedDiscordInstall, provisionDiscordAgent, sharedDiscordConfig } from './shared.js';
import { DiscordVoice } from './voice.js';

export const discordPlugin: AgentdPlugin = {
  name: 'discord',
  inject: ['store', 'enqueuer'],
  apply(ctx) {
    // One voice session holder per process, shared by the own-bot and shared-bot gateways; its tools reach it through the registration.
    const voice = new DiscordVoice({ store: ctx.service('store'), enqueuer: ctx.service('enqueuer'), transcriber: createTranscriber(process.env) });
    const registration: ChannelRegistration = {
      kind: 'discord',
      adapter: discordAdapter,
      connector: discordConnector,
      workspace: { configured: () => sharedDiscordConfig() !== undefined, enable: (deps, installation, agent) => provisionDiscordAgent(deps, installation, agent) },
      runners: [createSharedDiscordGateway(undefined, voice)],
      workingIndicator: true,
      groupHistory: true,
      delivery: discordDelivery,
      voice,
    };
    ctx.channels.register(registration);
    // Discord's redirect after the shared bot's invite; the api already tied `state` to a pending request and forwards as its owner.
    ctx.http.route({ method: 'get', path: '/v1/channels/discord/oauth/callback', handler: (c, deps) => completeSharedDiscordInstall(c, deps) });
  },
};
