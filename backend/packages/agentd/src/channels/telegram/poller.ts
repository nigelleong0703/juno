/**
 * Telegram long-poller (CH2): serves every telegram row when the deployment has no public webhook URL.
 *
 * One loop per row, rescanned every 30s so connects start polling and disconnects stop it. Each batch
 * of updates goes through the parser and the shared admission path as the row's owner, and the next
 * `getUpdates` offset is stored on the row after the batch so a restart does not re-admit. A 401 from
 * Telegram marks the row `invalid_token` and ends its loop; other errors back off and log.
 */
import { createLogger } from '@agent-desktop/log';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import { runWithOwner } from 'juno-agent/owner-context';
import { admitChannelEvent } from '../../routes/channels.js';
import type { ChannelRunner, ChannelRunnerContext } from '../runners.js';
import { parseTelegramUpdate, createTelegramApi } from '@agent-desktop/channels/telegram/api';
import { answerChannelClick } from '../interactions.js';
import { channelsPublicUrl } from '../public-url.js';
import { sleep, superviseRows } from '../supervise.js';

const log = createLogger({ service: 'agentd' });

const BACKOFF_MS = 5_000;

function updateId(update: unknown): number | undefined {
  const id = typeof update === 'object' && update !== null ? (update as Record<string, unknown>)['update_id'] : undefined;
  return typeof id === 'number' ? id : undefined;
}

async function pollRow(ctx: ChannelRunnerContext, rowId: string, signal: AbortSignal): Promise<void> {
  const api = createTelegramApi(ctx.channelFetch);
  while (!signal.aborted) {
    const row = await ctx.store.get('channels', rowId);
    if (!row || row.status === 'invalid_token' || row.botToken === undefined) return;
    let token: string;
    try {
      token = decryptSecret(row.botToken);
    } catch (err) {
      log.error({ err, channel: rowId }, 'telegram bot token could not be opened; polling stopped');
      return;
    }
    const res = await api.getUpdates(token, row.pollOffset, signal);
    if (signal.aborted) return;
    if (!res.ok) {
      if (res.status === 401) {
        await ctx.store.put('channels', { ...row, status: 'invalid_token', updatedAt: new Date().toISOString() });
        log.warn({ channel: rowId }, 'telegram rejected the bot token; polling stopped');
        return;
      }
      log.warn({ channel: rowId, status: res.status, error: res.error }, 'telegram poll failed; retrying');
      await sleep(BACKOFF_MS, signal);
      continue;
    }
    let next: number | undefined;
    for (const update of res.updates) {
      const id = updateId(update);
      if (id !== undefined) next = Math.max(next ?? 0, id + 1);
      const event = parseTelegramUpdate(update, row.channelId);
      const isTap = event === null && typeof update === 'object' && update !== null && 'callback_query' in update;
      if (event === null && !isTap) continue;
      try {
        const scoped = typeof ctx.store.forOwner === 'function' ? ctx.store.forOwner(row.ownerId) : ctx.store;
        const deps = { store: scoped, enqueuer: ctx.enqueuer, channels: ctx.channels, ...(ctx.channelFetch ? { channelFetch: ctx.channelFetch } : {}), ...(ctx.identity ? { identity: ctx.identity } : {}), ...(ctx.blobs ? { blobs: ctx.blobs } : {}) };
        if (event === null) {
          await answerChannelClick(deps, row.ownerId, 'telegram', row.channelId, update);
          continue;
        }
        const result = await runWithOwner(row.ownerId, () => admitChannelEvent(deps, row.ownerId, 'telegram', row.channelId, event));
        if (result.status >= 400) log.warn({ channel: rowId, status: result.status }, 'telegram update was not admitted');
      } catch (err) {
        log.warn({ err, channel: rowId }, 'telegram update failed');
      }
    }
    if (next !== undefined) await ctx.store.patch('channels', rowId, { pollOffset: next });
  }
}

export const telegramPoller: ChannelRunner = {
  start(ctx) {
    if (channelsPublicUrl() !== undefined) return () => undefined;
    return superviseRows(ctx, { kind: 'telegram', label: 'telegram poll', run: (rowId, signal) => pollRow(ctx, rowId, signal) });
  },
};
