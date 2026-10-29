/**
 * Discord Gateway runner: the one websocket of the shared Juno bot (every server rides it).
 *
 * HELLO starts the heartbeat and IDENTIFYs with the intents below. A missing heartbeat ack, RECONNECT or INVALID_SESSION ends the
 * session and the loop reconnects with backoff and a fresh IDENTIFY; messages redelivered that way dedupe by their deterministic
 * item id. Close code 4004 (bad token) stops it.
 */
import { createLogger } from '@agent-desktop/log';
import type { ChannelRunner, ChannelRunnerContext } from '../runners.js';
import { SHARED_VOICE_ROW_ID, type DiscordVoice } from './voice.js';
import { discordCall, type DiscordChannelEvent } from '@agent-desktop/channels/discord/api';
import { sleep } from '../supervise.js';
import { sharedDiscordConfig, sharedHooks, type SharedDiscordConfig, type SharedDiscordHooks } from './shared.js';

const log = createLogger({ service: 'agentd' });

const MAX_BACKOFF_MS = 60_000;
/** GUILDS | GUILD_VOICE_STATES (not privileged; voice sessions) | GUILD_MESSAGES | DIRECT_MESSAGES. */
export const DISCORD_INTENTS = (1 << 0) | (1 << 7) | (1 << 9) | (1 << 12);
const AUTH_FAILED = 4004;
/** Privileged: the text of messages that only mention a role. Switched on per app in the Developer Portal. */
export const MESSAGE_CONTENT_INTENT = 1 << 15;
const DISALLOWED_INTENTS = 4014;

export interface GatewaySocket {
  send(data: string): void;
  close(code?: number): void;
}

export interface GatewayHandlers {
  onMessage(data: string): void;
  onClose(code: number): void;
}

export type GatewaySocketFactory = (url: string, handlers: GatewayHandlers) => GatewaySocket;

/** Node's global WebSocket behind the minimal seam the runner needs. */
export const nodeSocketFactory: GatewaySocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener('message', (event) => { if (typeof event.data === 'string') handlers.onMessage(event.data); });
  socket.addEventListener('close', (event) => handlers.onClose(event.code));
  socket.addEventListener('error', () => handlers.onClose(1006));
  return { send: (data) => socket.send(data), close: (code) => socket.close(code) };
};

interface GatewayFrame {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

function parseFrame(data: string): GatewayFrame | null {
  try {
    const frame: unknown = JSON.parse(data);
    if (typeof frame !== 'object' || frame === null) return null;
    const record = frame as Record<string, unknown>;
    if (typeof record['op'] !== 'number') return null;
    return {
      op: record['op'],
      ...(typeof record['t'] === 'string' ? { t: record['t'] } : {}),
      ...(typeof record['s'] === 'number' ? { s: record['s'] } : {}),
      d: record['d'],
    };
  } catch {
    return null;
  }
}

/** What a live Gateway session shares with the voice sessions of its bot (see discord-voice.ts). */
interface VoiceHook {
  attach(send: (frame: string) => void): () => void;
  dispatch(type: string, data: unknown): void;
  decorate(event: DiscordChannelEvent): DiscordChannelEvent;
}

/** One Gateway session; resolves with the close code when it ends. */
function runSession(
  ctx: ChannelRunnerContext,
  factory: GatewaySocketFactory,
  url: string,
  token: string,
  signal: AbortSignal,
  onReady: () => void,
  voice: VoiceHook | undefined,
  shared: SharedDiscordHooks,
  intents: number,
): Promise<number> {
  return new Promise((resolve) => {
    let seq: number | null = null;
    let acked = true;
    let first: NodeJS.Timeout | undefined;
    let beat: NodeJS.Timeout | undefined;
    let done = false;
    let socket: GatewaySocket | undefined;
    let detachVoice: (() => void) | undefined;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      detachVoice?.();
      clearTimeout(first);
      clearInterval(beat);
      signal.removeEventListener('abort', onAbort);
      resolve(code);
    };
    const drop = (code: number): void => {
      try { socket?.close(code); } catch { /* already closed */ }
      finish(code);
    };
    const onAbort = (): void => drop(1000);
    const heartbeat = (): void => {
      if (!acked) { drop(4000); return; }
      acked = false;
      socket?.send(JSON.stringify({ op: 1, d: seq }));
    };
    const handle = (data: string): void => {
      const frame = parseFrame(data);
      if (frame === null) return;
      if (frame.s !== undefined) seq = frame.s;
      switch (frame.op) {
        case 10: {
          const interval = typeof (frame.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval === 'number'
            ? (frame.d as { heartbeat_interval: number }).heartbeat_interval
            : 41_250;
          first = setTimeout(() => { heartbeat(); beat = setInterval(heartbeat, interval); beat.unref(); }, Math.floor(interval * Math.random()));
          first.unref();
          socket?.send(JSON.stringify({
            op: 2,
            d: { token, intents, properties: { os: process.platform, browser: 'juno', device: 'juno' } },
          }));
          break;
        }
        case 11:
          acked = true;
          break;
        case 1:
          socket?.send(JSON.stringify({ op: 1, d: seq }));
          break;
        case 7:
        case 9:
          drop(4000);
          break;
        case 0:
          if (frame.t === 'READY') {
            onReady();
            detachVoice = voice?.attach((text) => socket?.send(text));
          } else if (frame.t === 'MESSAGE_CREATE') shared.onMessage(frame.d);
          else if (frame.t === 'INTERACTION_CREATE') shared.onInteraction(frame.d);
          else if (frame.t === 'GUILD_CREATE') {
            shared.onGuild(frame.d);
            voice?.dispatch(frame.t, frame.d);
          } else if (frame.t === 'VOICE_STATE_UPDATE' || frame.t === 'VOICE_SERVER_UPDATE') voice?.dispatch(frame.t, frame.d);
          break;
        default:
          break;
      }
    };
    if (signal.aborted) { finish(1000); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      socket = factory(url, { onMessage: handle, onClose: finish });
    } catch (err) {
      log.warn({ err }, 'discord gateway socket failed to open');
      finish(1006);
    }
  });
}

/** The shared bot's one voice connection (every server); its sessions carry the agent and owner that asked. */
function sharedVoiceHook(voice: DiscordVoice, botUserId: string, token: string): VoiceHook {
  return {
    attach: (send) => voice.attach({ rowId: SHARED_VOICE_ROW_ID, shared: true, botUserId, token, send }),
    dispatch: (type, data) => voice.dispatch(SHARED_VOICE_ROW_ID, type, data),
    decorate: (event) => voice.decorate(SHARED_VOICE_ROW_ID, event),
  };
}

/** The shared Juno bot's own Gateway: one connection, all servers. Falls back to no MESSAGE_CONTENT when the app has not been granted it. */
async function runShared(ctx: ChannelRunnerContext, factory: GatewaySocketFactory, config: SharedDiscordConfig, signal: AbortSignal, voiceSessions: DiscordVoice | undefined): Promise<void> {
  const fetchFn = ctx.channelFetch ?? fetch;
  let backoff = 1_000;
  let withContent = true;
  while (!signal.aborted) {
    const me = await discordCall(fetchFn, config.botToken, 'GET', '/users/@me');
    const info = await discordCall(fetchFn, config.botToken, 'GET', '/gateway/bot');
    const botUserId = me.ok && typeof me.body === 'object' && me.body !== null ? (me.body as Record<string, unknown>)['id'] : undefined;
    const url = info.ok && typeof info.body === 'object' && info.body !== null ? (info.body as Record<string, unknown>)['url'] : undefined;
    if (signal.aborted) return;
    if (typeof botUserId !== 'string' || typeof url !== 'string') {
      if (!me.ok && me.status === 401) { log.error('the shared discord bot token was rejected; its gateway is stopped'); return; }
      log.warn('shared discord gateway url unavailable; retrying');
    } else {
      const code = await runSession(
        ctx, factory, url + '?v=10&encoding=json', config.botToken, signal, () => { backoff = 1_000; },
        voiceSessions === undefined ? undefined : sharedVoiceHook(voiceSessions, botUserId, config.botToken),
        sharedHooks(ctx, config.botToken, botUserId, voiceSessions), withContent ? DISCORD_INTENTS | MESSAGE_CONTENT_INTENT : DISCORD_INTENTS,
      );
      if (signal.aborted) return;
      if (code === AUTH_FAILED) { log.error('the shared discord bot token was rejected; its gateway is stopped'); return; }
      if (code === DISALLOWED_INTENTS && withContent) {
        withContent = false;
        log.warn('MESSAGE_CONTENT is not enabled for the shared discord app; role mentions will not carry text');
      } else log.warn({ code }, 'shared discord gateway closed; reconnecting');
    }
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

/** The shared Juno bot's gateway (one connection for every server); `voice` carries its sessions. */
export function createSharedDiscordGateway(factory: GatewaySocketFactory = nodeSocketFactory, voice?: DiscordVoice): ChannelRunner {
  return {
    start(ctx) {
      const config = sharedDiscordConfig();
      if (config === undefined) return () => undefined;
      const controller = new AbortController();
      void runShared(ctx, factory, config, controller.signal, voice).catch((err: unknown) => log.error({ err }, 'shared discord gateway crashed'));
      return () => controller.abort();
    },
  };
}
