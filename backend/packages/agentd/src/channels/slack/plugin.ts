/**
 * The Slack plugin: the whole platform behind one registration (see registration.ts for the two layers).
 *  - communication layer: the connector (manifest app / shared Juno app), the Events API webhook shape (with mention resolution),
 *    outbound via packages/channels `slackAdapter.transport`; Slack needs no runner (events arrive by webhook);
 *  - capability layer: `slackAdapter.abilities` (reactions, history: a group mention brings the messages before it);
 *  - routes: the shared app's events and button taps, the per-channel button taps, and the manifest app's config token and install
 *    redirect (manifest.ts), mounted through `ctx.http.route` so disabling this plugin removes them.
 */
import { parseSlackEvent } from '@agent-desktop/channels/slack/api';
import { resolveSlackMentions, slackUserNamer } from '@agent-desktop/channels/slack/mentions';
import { slackAdapter } from '@agent-desktop/channels/sdk';
import { channelRowId } from '@agent-desktop/contracts';
import type { AgentdPlugin } from '../../plugins/services.js';
import { getOwnerId } from '../../auth.js';
import { acknowledgeThenAdmit } from '../../routes/channels.js';
import { openChannelRow } from '../credentials.js';
import type { WebhookContext, WebhookOutcome } from '../registration.js';
import { slackConnector } from './connect.js';
import { withSlackExternal } from './external.js';
import { completeSharedSlackInstall, handleSharedSlackEvent, handleSharedSlackInteraction, provisionSlackAgent, sharedSlackConfig, slackCarriesFiles } from './shared.js';

/** Slack retries non-2xx within seconds, so an event the agent should not hear is answered 200 (`answered`). */
async function slackWebhook({ deps, channelId, body }: WebhookContext): Promise<WebhookOutcome> {
  if (typeof body !== 'object' || body === null || !('event_id' in body)) return { event: body };
  // The channel id is opaque; the bot user id lives on the row (absent until the app is installed).
  const row = await deps.store.get('channels', channelRowId('slack', channelId));
  const event = row?.botUserId === undefined ? null : parseSlackEvent(body, row.botUserId);
  if (event === null || row === null) return { answered: true };
  const opened = await openChannelRow(deps.store, row);
  const token = 'error' in opened ? undefined : opened.channel.botToken;
  const resolved = token === undefined ? undefined : await resolveSlackMentions(slackUserNamer(deps.channelFetch ?? fetch, token), event.text);
  const message = resolved === undefined ? event : { ...event, text: resolved.text, ...(resolved.mentions.length === 0 ? {} : { mentions: resolved.mentions }) };
  return { event: await withSlackExternal(deps.channelFetch ?? fetch, token, message) };
}

export const slackPlugin: AgentdPlugin = {
  name: 'slack',
  apply(ctx) {
    ctx.channels.register({
      kind: 'slack',
      adapter: slackAdapter,
      connector: slackConnector,
      workspace: { configured: () => sharedSlackConfig() !== undefined, enable: (deps, installation, agent) => provisionSlackAgent(deps, installation, agent) },
      webhook: slackWebhook,
      answersFirst: slackCarriesFiles,
      groupHistory: true,
      workingIndicator: true,
    });
    // The shared Juno Slack app: one events / interactions URL for every workspace. The api verified the shared signing secret and
    // forwards as the installation's owner; the workspace (`team_id`) picks the installation, a user group mention picks the agent.
    ctx.http.route({
      method: 'post',
      path: '/v1/channels/slack/events',
      handler: async (c, deps) => {
        const ownerId = getOwnerId(c);
        const body: unknown = await c.req.json().catch(() => null);
        if (body === null) return c.json({ error: { code: 'INVALID_CHANNEL_EVENT', message: 'Channel event body must be JSON' } }, 400);
        if (slackCarriesFiles(body)) return acknowledgeThenAdmit(c, () => handleSharedSlackEvent(deps, ownerId, body));
        const result = await handleSharedSlackEvent(deps, ownerId, body);
        return c.json(result.body, result.status);
      },
    });
    ctx.http.route({
      method: 'post',
      path: '/v1/channels/slack/interactions',
      handler: async (c, deps) => {
        const form: Record<string, unknown> = await c.req.parseBody().catch(() => ({}));
        await handleSharedSlackInteraction(deps, getOwnerId(c), form).catch(() => undefined);
        return c.body(null, 200);
      },
    });
    // Slack's redirect after the install (carrying our `state`): the api forwards it as the pending install's owner.
    ctx.http.route({ method: 'get', path: '/v1/channels/slack/oauth/callback', handler: (c, deps) => completeSharedSlackInstall(c, deps) });
  },
};
