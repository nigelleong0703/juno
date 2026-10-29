/**
 * Telegram managed bots (CH7, Bot API 9.6): Juno's manager bot creates a bot per agent.
 *
 * The owner taps `https://t.me/newbot/<manager>/<suggested_username>?name=<name>`; Telegram creates the
 * bot under the owner's account (the owner can still manage it in @BotFather) and tells the manager bot
 * with a `managed_bot` update carrying `user` (the creator) and `bot`. The deep link has no payload, so a
 * request is correlated by the suggested username: the update is matched to the pending request whose
 * suggested username is the new bot's username. The creator's user id binds the owner automatically.
 * The manager bot is read by long polling (a `getUpdates` loop) so it needs no public URL.
 *
 * Needs `TELEGRAM_MANAGER_BOT_TOKEN`: a bot with Bot Management Mode enabled in @BotFather.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '@agent-desktop/log';
import type { Store } from '@agent-desktop/contracts';
import type { ConnectContext, ConnectOutcome } from '../connect.js';
import { createPending, livePending, settlePending } from '../pending.js';
import type { ChannelRunner, ChannelRunnerContext } from '../runners.js';
import { createTelegramApi } from '@agent-desktop/channels/telegram/api';
import { finishTelegramChannel } from './connect.js';

const log = createLogger({ service: 'agentd' });

const PENDING_TTL_MS = 15 * 60_000;
const BACKOFF_MS = 5_000;
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,30}[bB][oO][tT]$/;

const bodySchema = z.object({ mode: z.literal('managed'), suggestedUsername: z.string().trim().optional() });

const managedBotUpdateSchema = z.object({
  update_id: z.number(),
  managed_bot: z.object({
    user: z.object({ id: z.number() }),
    bot: z.object({ id: z.number(), username: z.string().optional() }),
  }),
});

/** The manager bot's token; unset hides the whole mode. */
export function managerBotToken(): string | undefined {
  const raw = process.env['TELEGRAM_MANAGER_BOT_TOKEN']?.trim();
  return raw ? raw : undefined;
}

function generatedUsername(handle: string): string {
  const slug = handle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  return 'juno_' + (slug === '' ? 'agent' : slug) + '_' + randomBytes(3).toString('hex') + '_bot';
}

export async function connectManagedTelegram({ deps, ownerId, agentId, body }: ConnectContext): Promise<ConnectOutcome> {
  const token = managerBotToken();
  if (token === undefined) return { ok: false, status: 400, code: 'MANAGED_BOTS_UNAVAILABLE', message: 'Automatic Telegram bots are not set up on this server' };
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'suggestedUsername must be a string' };
  const agent = await deps.store.get('agents', agentId);
  const suggested = parsed.data.suggestedUsername || generatedUsername(agent?.handle ?? agentId);
  if (!USERNAME.test(suggested)) {
    return { ok: false, status: 400, code: 'INVALID_USERNAME', message: 'A bot username is 5-32 letters, digits or underscores and ends in "bot"' };
  }
  const clash = (await livePending(deps.store, 'telegram')).some((row) => row.pending?.suggestedUsername?.toLowerCase() === suggested.toLowerCase());
  if (clash) return { ok: false, status: 409, code: 'USERNAME_PENDING', message: 'Another bot with this username is being created' };
  const me = await createTelegramApi(deps.channelFetch).getMe(token);
  if (!me.ok) return { ok: false, status: 502, code: 'TELEGRAM_UNREACHABLE', message: 'The manager bot could not be reached' };
  const name = (agent?.name ?? suggested).slice(0, 64);
  const createUrl = 'https://t.me/newbot/' + me.username + '/' + suggested + '?name=' + encodeURIComponent(name);
  const pending = await createPending(deps.store, {
    ownerId,
    agentId,
    ttlMs: PENDING_TTL_MS,
    data: { platform: 'telegram', suggestedUsername: suggested, createUrl },
  });
  return { ok: true, pending, createUrl };
}

/**
 * One manager-bot update. A `managed_bot` for a request we hold creates the channel; the same bot
 * announcing itself again (token or owner changed) refreshes the stored token.
 */
export async function handleManagerUpdate(
  ctx: { store: Store; channelFetch?: typeof fetch },
  managerToken: string,
  update: unknown,
): Promise<void> {
  const parsed = managedBotUpdateSchema.safeParse(update);
  if (!parsed.success) return;
  const { user, bot } = parsed.data.managed_bot;
  const username = bot.username;
  if (username === undefined) return;
  const api = createTelegramApi(ctx.channelFetch);
  const request = (await livePending(ctx.store, 'telegram')).find((row) => row.pending?.suggestedUsername?.toLowerCase() === username.toLowerCase());
  const existing = await ctx.store.get('channels', 'telegram:' + username);
  if (request === undefined && existing === null) {
    log.warn({ bot: username }, 'managed bot created with no matching request (the owner may have changed the username)');
    return;
  }
  const fetched = await api.getManagedBotToken(managerToken, bot.id);
  if (!fetched.ok) {
    if (request) await settlePending(ctx.store, request.channelId, { state: 'failed', error: 'Telegram would not hand over the new bot token' });
    log.warn({ bot: username, status: fetched.status }, 'getManagedBotToken failed');
    return;
  }
  const target = request ?? existing;
  if (target === null) return;
  const done = await finishTelegramChannel(ctx, {
    ownerId: target.ownerId,
    agentId: target.agentId,
    botToken: fetched.token,
    username,
    ownerExternalId: String(user.id),
  });
  if (request) {
    await settlePending(ctx.store, request.channelId, done.ok ? { state: 'connected', resultRowId: done.row.id } : { state: 'failed', error: done.message });
  }
}

/** Long-polls the manager bot. Idle (and cheap) when the token is unset. */
export const telegramManagerRunner: ChannelRunner = {
  start(ctx: ChannelRunnerContext) {
    const token = managerBotToken();
    if (token === undefined) return () => undefined;
    const controller = new AbortController();
    const api = createTelegramApi(ctx.channelFetch);
    void (async () => {
      let offset: number | undefined;
      while (!controller.signal.aborted) {
        const res = await api.getUpdates(token, offset, controller.signal, ['managed_bot']);
        if (controller.signal.aborted) return;
        if (!res.ok) {
          log.warn({ status: res.status, error: res.error }, 'telegram manager bot poll failed; retrying');
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS).unref());
          continue;
        }
        for (const update of res.updates) {
          const id = typeof update === 'object' && update !== null ? (update as Record<string, unknown>)['update_id'] : undefined;
          if (typeof id === 'number') offset = Math.max(offset ?? 0, id + 1);
          try {
            await handleManagerUpdate(ctx, token, update);
          } catch (err) {
            log.warn({ err }, 'telegram manager update failed');
          }
        }
      }
    })().catch((err: unknown) => log.error({ err }, 'telegram manager loop crashed'));
    return () => controller.abort();
  },
};
