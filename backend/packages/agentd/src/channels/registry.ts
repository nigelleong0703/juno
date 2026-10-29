/**
 * The chat platforms agentd runs: the registrations the loaded platform plugins made (plugins/host.ts), looked up by kind.
 * This is the only place core code gets a platform from; there is no built-in list to fall back to. A platform whose plugin is
 * disabled (`JUNO_PLUGINS`) or failed is simply absent, and every user of the registry says so with `unavailableMessage`.
 */
import type { ChannelSender } from '@agent-desktop/channels/types';
import type { ChannelRow } from '@agent-desktop/contracts';
import type { VoicePort } from 'juno-agent/modules/tools/tools/discordVoice';
import type { ChannelDeliveryHooks, ChannelRegistration } from './registration.js';

/** An outbound sender with its platform's delivery hooks (absent when the platform has none). */
export type ChannelOutbound = ChannelSender & { delivery?: ChannelDeliveryHooks };

/** One outbound sender per platform kind; undefined when no plugin registered the platform. */
export type ChannelSenders = (kind: string) => ChannelOutbound | undefined;

export interface ChannelRegistry {
  get(kind: string): ChannelRegistration | undefined;
  all(): ChannelRegistration[];
  /** The platform's name for people ("Slack", "Lark"); the kind itself when the platform is not registered. */
  displayName(row: Pick<ChannelRow, 'kind' | 'domain'>): string;
  /** The senders of the registered platforms (each with its group reply planner); `channelFetch` is injected for tests. */
  senders(channelFetch?: typeof fetch): ChannelSenders;
  /** The voice sessions of the registered platforms (one platform offers them today); undefined when none does. */
  voice(): VoicePort | undefined;
}

export const unavailableMessage = (kind: string): string => `The ${kind} platform is not available on this server: its plugin is disabled or not installed`;

/** A view over the plugin host's registrations (the host seals them once plugins have loaded). */
export function channelRegistryOf(source: { channels(): ChannelRegistration[] }): ChannelRegistry {
  const get = (kind: string): ChannelRegistration | undefined => source.channels().find((registration) => registration.kind === kind);
  return {
    get,
    all: () => source.channels(),
    displayName: (row) => get(row.kind)?.adapter.identity.displayName(row) ?? row.kind,
    senders: (channelFetch) => (kind) => {
      const registration = get(kind);
      const sender = registration?.adapter.transport.sender(channelFetch);
      return sender === undefined || registration === undefined ? undefined : {
        ...sender,
        ...(registration.delivery === undefined ? {} : { delivery: registration.delivery }),
      };
    },
    voice: () => source.channels().find((registration) => registration.voice !== undefined)?.voice,
  };
}
