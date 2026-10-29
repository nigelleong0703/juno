/**
 * Telegram connector: the bot is created for the person with Telegram's Managed Bots (`{mode:'managed'}`, managed.ts); nobody pastes
 * a BotFather token. `finishTelegramChannel` stores the row for the token the platform handed over and picks the receive mode.
 *
 * With CHANNELS_PUBLIC_URL set Telegram pushes updates to the public webhook (secret_token = the row's
 * webhook secret); without it the webhook is cleared and the long-poller serves the row.
 */
import { channelRowId, type ChannelRow, type Store } from '@agent-desktop/contracts';
import { decryptSecret, encryptSecret } from '@agent-desktop/contracts/secrets';
import type { ChannelConnector } from '../connect.js';
import { newSecret } from '../bind.js';
import { createTelegramApi } from '@agent-desktop/channels/telegram/api';
import { connectManagedTelegram } from './managed.js';
import { channelsPublicUrl } from '../public-url.js';

export interface TelegramFinishInput {
  ownerId: string;
  agentId: string;
  botToken: string;
  username: string;
  /** Telegram user id of the person who created the bot: the platform tells us who the owner is. */
  ownerExternalId: string;
}

type Failure = { ok: false; status: 400 | 409 | 502; code: string; message: string };

/**
 * Writes the row for a bot token Telegram handed over and picks the receive mode.
 */
export async function finishTelegramChannel(
  deps: { store: Store; channelFetch?: typeof fetch },
  input: TelegramFinishInput,
): Promise<{ ok: true; row: ChannelRow } | Failure> {
  const api = createTelegramApi(deps.channelFetch);
  const id = channelRowId('telegram', input.username);
  const existing = await deps.store.get('channels', id);
  const taken: Failure = { ok: false, status: 409, code: 'CHANNEL_EXISTS', message: 'This bot is already connected to another agent' };
  if (existing && existing.agentId !== input.agentId) return taken;
  const webhookSecret = newSecret();
  const now = new Date().toISOString();
  const row: ChannelRow = {
    id,
    ownerId: input.ownerId,
    agentId: input.agentId,
    kind: 'telegram',
    channelId: input.username,
    secretHashHex: webhookSecret.hashHex,
    botToken: encryptSecret(input.botToken),
    ownerExternalId: input.ownerExternalId,
    status: 'active',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  try {
    // The store refuses to overwrite a row another owner holds.
    await deps.store.put('channels', row);
  } catch {
    return taken;
  }
  const publicUrl = channelsPublicUrl();
  const receive = publicUrl === undefined
    ? await api.deleteWebhook(input.botToken)
    : await api.setWebhook(input.botToken, publicUrl + '/v1/channels/telegram/' + input.username + '/events', webhookSecret.secret);
  if (!receive.ok) {
    await deps.store.delete('channels', id);
    return { ok: false, status: 502, code: 'TELEGRAM_SETUP_FAILED', message: 'Telegram refused the receive setup: ' + receive.error };
  }
  return { ok: true, row };
}

export const telegramConnector: ChannelConnector = {
  async connect(ctx) {
    const mode = typeof ctx.body === 'object' && ctx.body !== null ? (ctx.body as Record<string, unknown>)['mode'] : undefined;
    if (mode !== 'managed') return { ok: false, status: 400, code: 'UNSUPPORTED_CONNECT_MODE', message: "Telegram bots are created for you: send {mode:'managed'}" };
    return connectManagedTelegram(ctx);
  },

  async disconnect(deps, row) {
    if (row.botToken === undefined) return;
    try {
      await createTelegramApi(deps.channelFetch).deleteWebhook(decryptSecret(row.botToken));
    } catch {
      // Best effort: the row is deleted either way.
    }
  },
};
