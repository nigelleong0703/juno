/**
 * The real @discordjs/voice connection behind the seam discord-voice.ts uses (tests fake this file's
 * contract). The library does the voice websocket, UDP, encryption and DAVE end-to-end decryption of
 * received audio; it talks to Discord's main gateway through an adapter that our Gateway session feeds,
 * so there is one gateway connection per bot and no second discord client.
 */
import {
  EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel,
  type DiscordGatewayAdapterCreator, type DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import OpusScript from 'opusscript';

/** Silence that ends one utterance. */
const SILENCE_MS = 1_200;
const READY_TIMEOUT_MS = 20_000;

export interface AdapterBridge {
  /** Sends a gateway op 4 frame body (`d`) for this voice join or leave. */
  sendVoiceState(d: Record<string, unknown>): boolean;
  /** Registers the library's handlers for VOICE_SERVER_UPDATE / VOICE_STATE_UPDATE; the return unregisters. */
  subscribe(handlers: { server(d: unknown): void; state(d: unknown): void; destroy(): void }): () => void;
}

export interface VoiceLink {
  /** Calls back whenever a user starts speaking. */
  onSpeaking(callback: (userId: string) => void): void;
  /** One utterance of a speaker as Opus packets; ends after a pause. */
  utterance(userId: string): AsyncIterable<Buffer>;
  destroy(): void;
}

export type JoinVoice = (args: { guildId: string; channelId: string; bridge: AdapterBridge }) => Promise<VoiceLink>;

/** Opus packet to 48 kHz stereo s16le PCM. */
export type OpusDecode = (packet: Buffer) => Buffer;

export function createOpusDecoder(): OpusDecode {
  const decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  return (packet) => decoder.decode(packet);
}

export const joinWithLibrary: JoinVoice = async ({ guildId, channelId, bridge }) => {
  const adapterCreator: DiscordGatewayAdapterCreator = (methods: DiscordGatewayAdapterLibraryMethods) => {
    // The payloads are Discord's documented gateway dispatch data; the library validates what it uses.
    const unsubscribe = bridge.subscribe({
      server: (d) => methods.onVoiceServerUpdate(d as Parameters<DiscordGatewayAdapterLibraryMethods['onVoiceServerUpdate']>[0]),
      state: (d) => methods.onVoiceStateUpdate(d as Parameters<DiscordGatewayAdapterLibraryMethods['onVoiceStateUpdate']>[0]),
      destroy: () => methods.destroy(),
    });
    return {
      sendPayload: (payload) => bridge.sendVoiceState((payload as { d: Record<string, unknown> }).d),
      destroy: unsubscribe,
    };
  };
  const connection = joinVoiceChannel({ channelId, guildId, adapterCreator, selfDeaf: false, selfMute: true });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (err) {
    connection.destroy();
    throw err;
  }
  return {
    onSpeaking: (callback) => { connection.receiver.speaking.on('start', callback); },
    utterance: (userId) => connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS } }),
    destroy: () => { if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy(); },
  };
};
