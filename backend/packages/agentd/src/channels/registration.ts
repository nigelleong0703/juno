/**
 * What one chat-platform plugin registers (`ctx.channels.register`): the whole platform behind one object, in the two layers.
 *  - communication layer: `adapter.transport` (outbound sender), `connector` (connect / disconnect an identity), `runners`
 *    (the long poll, gateway or socket that receives), `webhook` (the platform's own webhook body to the shared event),
 *    `workingIndicator`, and the outbound hooks `delivery` around a send;
 *  - capability layer: `adapter.abilities` (react / history / attachment / sendFile, each answering `unsupported` when the
 *    platform lacks it) and `adapter.capabilities` (what a chat can do; the plugin host registers it with public-contracts).
 * HTTP routes of a platform (its OAuth callback, its shared events URL, its button taps) are not here: a plugin adds them
 * through `ctx.http.route`. Core code never names a platform: it looks the registration up by `kind` in the ChannelRegistry.
 */
import type { ChannelInstallation, ChannelRow, Store } from '@agent-desktop/contracts';
import type { Agent } from '@agent-desktop/public-contracts';
import type { ChannelAdapter } from '@agent-desktop/channels/sdk';
import type { AdapterResult } from '@agent-desktop/channels/abilities';
import type { VoicePort } from 'juno-agent/modules/tools/tools/discordVoice';
import type { ChannelConnector } from './connect.js';
import type { ChannelRunner } from './runners.js';
import type { ChannelRegistry } from './registry.js';
import type { AgentdDeps } from '../routes/index.js';

export interface WebhookContext {
  deps: AgentdDeps;
  ownerId: string;
  channelId: string;
  /** The JSON body the platform posted (already verified by the api gateway). */
  body: unknown;
}

/** `answered`: the body was the platform's own business (a button tap, an update the agent should not hear), so the route replies 200 and admits nothing. `event`: continue with this event body. */
export type WebhookOutcome = { answered: true } | { event: unknown };

/** Outbound hooks around one send. Absent: the text goes out as the sender renders it and nothing is recorded beyond the receipt. */
export interface ChannelDeliveryHooks {
  /** Rewrites the text before it is sent (Discord: "@Name" of another agent of the same install becomes that agent's role tag). */
  prepareText?(input: { store: Store; installationId: string; senderAgentId: string; text: string }): Promise<string>;
  /** After a send that returned the platform's message ids (Discord: each one is recorded with the agent and run that wrote it). */
  sent?(input: { store: Store; conversationId: string; item: { id: string; agentId: string; runId?: string }; externalIds: readonly string[]; now: string }): Promise<void>;
}

/** The two chat abilities whose outcome a platform may need to act on (Feishu: a refused scope takes the grant off the row). */
export type ChatAbility = 'react' | 'history';

/**
 * A platform where one Juno bot is installed into a workspace once and each agent is then enabled there (Slack, Discord): the
 * installation is a `channelInstallations` row, an enabled agent is a `channels` row on it. Disabling an agent is the connector's
 * `disconnect` plus deleting that row.
 */
export interface WorkspaceInstall {
  /** The shared bot's credentials are configured on this deployment, so a workspace can be installed. */
  configured(): boolean;
  /** Enables the agent in the workspace: its `channels` row, and the name people @-mention it by when the platform allows one. Idempotent. */
  enable(deps: { store: Store; channelFetch?: typeof fetch }, installation: ChannelInstallation, agent: Pick<Agent, 'id' | 'name'>): Promise<ChannelRow>;
}

export interface ChannelRegistration {
  /** The platform kind: the `channels` row kind, the `:kind` of the connect and webhook routes, the `kind` of a chat origin. */
  kind: string;
  /** Present when the platform has a shared bot that is installed per workspace (Slack, Discord). */
  workspace?: WorkspaceInstall;
  /** Transport (outbound) and abilities (capability layer), from packages/channels. */
  adapter: ChannelAdapter;
  connector: ChannelConnector;
  /** Background work the platform needs while agentd is up; started after all plugins have loaded, stopped with agentd. */
  runners?: readonly ChannelRunner[];
  /** Prepares a webhook body before the shared admission; absent: the body is already the normalized event. */
  webhook?(ctx: WebhookContext): Promise<WebhookOutcome>;
  /** A webhook body the platform answers at once and admits afterwards (Slack with files: the downloads can outlast its 3-second answer). */
  answersFirst?(body: unknown): boolean;
  /** Whether whoever mentions the agent in a group also brings the messages before it, read through the history ability (Discord, Slack). */
  groupHistory?: boolean;
  /** Whether a woken chat shows the "working" mark (a reaction taken off when the run ends). False where the platform cannot do that cleanly. */
  workingIndicator: boolean;
  /** Outbound hooks around a send (see ChannelDeliveryHooks). */
  delivery?: ChannelDeliveryHooks;
  /** Called with the outcome of a react or history call, so the platform can record what its grants allow. */
  abilityOutcome?(store: Store, row: ChannelRow, ability: ChatAbility, result: AdapterResult<unknown>): Promise<void>;
  /** Called (fire and forget) when a group message of this platform is admitted (Feishu: a cheap probe of the group-read scope). */
  groupAdmitted?(deps: { store: Store; channels: ChannelRegistry; channelFetch?: typeof fetch }, row: ChannelRow, chat: { chatId: string; threadId: string }): Promise<void>;
  /** The platform's voice sessions, when it has them (Discord); the voice tools are offered when one is registered. */
  voice?: VoicePort;
}
