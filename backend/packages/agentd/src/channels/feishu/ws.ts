/**
 * Feishu / Lark long connection: one WSClient per feishu row, rescanned every 30s like the Telegram poller.
 *
 * The official SDK owns the socket and its reconnects; `im.message.receive_v1` events go through the
 * parser and the shared admission path as the row's owner. `WSClient.close()` ends a connection when
 * the row disappears or agentd stops. The SDK sits behind `FeishuWsFactory` so tests inject a fake.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@agent-desktop/log';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import { runWithOwner } from 'juno-agent/owner-context';
import { admitChannelEvent } from '../../routes/channels.js';
import type { ChannelRunner, ChannelRunnerContext } from '../runners.js';
import { handleMeetingInvite, startMeetingPoller } from './meeting.js';
import { answerChannelClick } from '../interactions.js';
import { superviseRows, untilAborted } from '../supervise.js';
import { feishuBaseUrl, fetchFeishuBotInfo, parseFeishuMessage, type FeishuCredentials } from '@agent-desktop/channels/feishu/api';

const log = createLogger({ service: 'agentd' });

export interface FeishuConnection {
  close(): void;
}

/** Opens a long connection that calls `onMessage` with each im.message.receive_v1 event body. */
/** `onCardAction` answers a card button press with the response body (toast, redrawn card). */
export type FeishuWsFactory = (creds: FeishuCredentials, onMessage: (event: unknown) => Promise<void>, onMeetingInvited?: (event: unknown) => Promise<void>, onCardAction?: (event: unknown) => Promise<Record<string, unknown> | undefined>) => FeishuConnection;

export const sdkWsFactory: FeishuWsFactory = (creds, onMessage, onMeetingInvited, onCardAction) => {
  const client = new lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
    domain: feishuBaseUrl(creds.domain),
    loggerLevel: lark.LoggerLevel.warn,
  });
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => { await onMessage(data); },
    'vc.bot.meeting_invited_v1': async (data: unknown) => { await onMeetingInvited?.(data); },
    'card.action.trigger': async (data: unknown) => (await onCardAction?.(data)) ?? {},
  });
  void client.start({ eventDispatcher: dispatcher }).catch((err: unknown) => log.warn({ err, app: creds.appId }, 'feishu long connection failed to start'));
  return { close: () => client.close({ force: true }) };
};

export function createFeishuRunner(factory: FeishuWsFactory = sdkWsFactory): ChannelRunner {
  return {
    start(ctx: ChannelRunnerContext) {
      const meetingDeps = { store: ctx.store, enqueuer: ctx.enqueuer, home: ctx.home, ...(ctx.channelFetch ? { fetchFn: ctx.channelFetch } : {}) };
      const meetings = startMeetingPoller(meetingDeps);
      /** Serves one row: the long connection is open for as long as the row lives (a failed bot lookup ends the attempt; the next rescan retries). */
      const connect = async (rowId: string, signal: AbortSignal): Promise<void> => {
        const row = await ctx.store.get('channels', rowId);
        if (!row || row.botToken === undefined || signal.aborted) return;
        const creds: FeishuCredentials = { appId: row.channelId, appSecret: decryptSecret(row.botToken), domain: row.domain ?? 'feishu' };
        const bot = await fetchFeishuBotInfo(ctx.channelFetch ?? fetch, creds);
        if (!bot.ok) {
          log.warn({ channel: rowId, error: bot.error }, 'feishu bot lookup failed; will retry');
          return;
        }
        if (signal.aborted) return;
        const onMessage = async (data: unknown): Promise<void> => {
          const event = parseFeishuMessage(data, bot.data.openId);
          if (event === null) return;
          try {
            const scoped = typeof ctx.store.forOwner === 'function' ? ctx.store.forOwner(row.ownerId) : ctx.store;
            const deps = { store: scoped, enqueuer: ctx.enqueuer, channels: ctx.channels, ...(ctx.channelFetch ? { channelFetch: ctx.channelFetch } : {}), ...(ctx.identity ? { identity: ctx.identity } : {}), ...(ctx.blobs ? { blobs: ctx.blobs } : {}) };
            const result = await runWithOwner(row.ownerId, () => admitChannelEvent(deps, row.ownerId, 'feishu', row.channelId, event));
            if (result.status >= 400) log.warn({ channel: rowId, status: result.status }, 'feishu message was not admitted');
          } catch (err) {
            log.warn({ err, channel: rowId }, 'feishu message failed');
          }
        };
        const onMeetingInvited = async (data: unknown): Promise<void> => {
          const current = await ctx.store.get('channels', rowId);
          if (current) await handleMeetingInvite(meetingDeps, current, data).catch((err: unknown) => log.warn({ err, channel: rowId }, 'meeting invitation failed'));
        };
        const onCardAction = async (data: unknown): Promise<Record<string, unknown> | undefined> => {
          try {
            const scoped = typeof ctx.store.forOwner === 'function' ? ctx.store.forOwner(row.ownerId) : ctx.store;
            const deps = { store: scoped, enqueuer: ctx.enqueuer, channels: ctx.channels, ...(ctx.channelFetch ? { channelFetch: ctx.channelFetch } : {}), ...(ctx.identity ? { identity: ctx.identity } : {}), ...(ctx.blobs ? { blobs: ctx.blobs } : {}) };
            return (await answerChannelClick(deps, row.ownerId, 'feishu', row.channelId, data)).response;
          } catch (err) {
            log.warn({ err, channel: rowId }, 'feishu card action failed');
            return undefined;
          }
        };
        const connection = factory(creds, onMessage, onMeetingInvited, onCardAction);
        await untilAborted(signal);
        connection.close();
      };
      const stopRows = superviseRows(ctx, { kind: 'feishu', label: 'feishu connection', run: connect });
      return () => {
        meetings.stop();
        stopRows();
      };
    },
  };
}

export const feishuRunner: ChannelRunner = createFeishuRunner();
