import { discordCall } from './api.js';

/** "#general" for a Discord channel id, or undefined when the lookup fails. */
export async function discordChannelName(fetchFn: typeof fetch, token: string, chatId: string): Promise<string | undefined> {
  const info = await discordCall(fetchFn, token, 'GET', '/channels/' + chatId);
  const raw = info.ok && typeof info.body === 'object' && info.body !== null ? (info.body as Record<string, unknown>)['name'] : undefined;
  return typeof raw === 'string' && raw !== '' ? '#' + raw : undefined;
}
