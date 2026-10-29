/**
 * The Telegram plugin: the whole platform behind one registration (see registration.ts for the two layers).
 *  - communication layer: the connector (bot token / managed bot), the long poller and the managed-bot runner, the webhook shapes
 *    (updates and button taps), outbound via packages/channels `telegramAdapter.transport`;
 *  - capability layer: `telegramAdapter.abilities` (reactions only; no history, no files).
 * Telegram has no "working" mark: a reaction there is replaced rather than taken off.
 */
import { parseTelegramUpdate } from '@agent-desktop/channels/telegram/api';
import { telegramAdapter } from '@agent-desktop/channels/sdk';
import type { AgentdPlugin } from '../../plugins/services.js';
import type { WebhookContext, WebhookOutcome } from '../registration.js';
import { telegramConnector } from './connect.js';
import { telegramManagerRunner } from './managed.js';
import { telegramPoller } from './poller.js';
import { answerChannelClick } from '../interactions.js';

/** Telegram retries every non-2xx, so an update or tap the agent should not hear is answered 200 (`answered`). */
async function telegramWebhook({ deps, ownerId, channelId, body }: WebhookContext): Promise<WebhookOutcome> {
  if (typeof body !== 'object' || body === null) return { event: body };
  if ('callback_query' in body) {
    await answerChannelClick(deps, ownerId, 'telegram', channelId, body).catch(() => undefined);
    return { answered: true };
  }
  if ('update_id' in body) {
    const event = parseTelegramUpdate(body, channelId);
    return event === null ? { answered: true } : { event };
  }
  return { event: body };
}

export const telegramPlugin: AgentdPlugin = {
  name: 'telegram',
  apply(ctx) {
    ctx.channels.register({
      kind: 'telegram',
      adapter: telegramAdapter,
      connector: telegramConnector,
      runners: [telegramPoller, telegramManagerRunner],
      webhook: telegramWebhook,
      workingIndicator: false,
    });
  },
};
