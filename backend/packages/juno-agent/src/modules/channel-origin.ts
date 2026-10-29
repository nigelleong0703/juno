/**
 * Where a run's replies go: the wake that started the run says. Its payload carries the
 * platform chat (written by agentd's channel ingress); the run's agent messages are stamped with it (`replyTo`) and channel delivery
 * sends exactly those. A run woken in the app has no origin and its replies stay in the app.
 */
import type { ChannelOrigin } from '@agent-desktop/public-contracts';
import type { Store, WakeEvent } from '../contracts/index.js';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The platform's own id of the message that woke this run (Telegram and Slack carry "<chat>:<id>"); undefined for a wake no platform message started. */
export function wakeMessageId(wake: WakeEvent): string | undefined {
  const external = text(wake.payload['externalMessageId']);
  return external === undefined ? undefined : external.slice(external.lastIndexOf(':') + 1);
}

/** The optional platform permissions the origin's channel was granted (they widen the chat's capability row); none when unknown. */
export async function channelGrants(store: Store, origin: ChannelOrigin | undefined): Promise<string[]> {
  if (origin === undefined || origin.kind !== 'feishu') return [];
  return (await store.get('channels', origin.kind + ':' + origin.channelId))?.grantedScopes ?? [];
}

/** Whether the owner lets this agent read earlier messages of a platform chat (the `readHistory` permission tier; on unless switched off). */
export function readsChatHistory(agent: { permissionTiers?: { readHistory?: 'on' | 'off' } } | null | undefined): boolean {
  return agent?.permissionTiers?.readHistory !== 'off';
}

/** The platform chat of the latest user-originated wake, or undefined when that wake came from the app (or there is none). */
export function replyOriginOf(wakes: readonly WakeEvent[]): ChannelOrigin | undefined {
  for (let i = wakes.length - 1; i >= 0; i--) {
    const wake = wakes[i];
    if (wake === undefined || (wake.kind !== 'user_message' && wake.kind !== 'room_mention')) continue;
    const kind = text(wake.payload['channelKind']);
    const channelId = text(wake.payload['channelId']);
    const chatId = text(wake.payload['chatId']) ?? text(wake.payload['threadId']);
    if (kind === undefined || channelId === undefined || chatId === undefined) return undefined;
    const threadId = text(wake.payload['threadId']);
    const group = wake.kind === 'room_mention';
    // The platform's own id of the triggering message ("<chat>:<id>" on Telegram and Slack, the bare id on Discord), so a group reply is threaded under it.
    const external = text(wake.payload['externalMessageId']);
    const messageId = group && external !== undefined && (kind === 'telegram' || kind === 'slack' || kind === 'discord') ? external.slice(external.lastIndexOf(':') + 1) : undefined;
    const userId = group ? text(wake.payload['speakerId']) : undefined;
    return { kind, channelId, chatId, ...(threadId === undefined ? {} : { threadId }), chatType: group ? 'group' : 'private', ...(messageId === undefined || messageId === '' ? {} : { messageId }), ...(userId === undefined ? {} : { userId }) };
  }
  return undefined;
}
