/**
 * The outside-members flag of a Slack group message (Slack Connect: the channel is shared with another organization). Read from
 * `conversations.info` (is_ext_shared), cached an hour in the channels package. A Slack app without channels:read / groups:read
 * cannot tell: such a channel is treated as NOT external (otherwise every group would go quiet), and that is logged once per channel.
 * Any other failure leaves the group quiet until a later message can be read.
 */
import type { ChannelInboundEvent } from '@agent-desktop/channels/types';
import { slackChannelExternal } from '@agent-desktop/channels/slack/abilities';
import { createLogger } from '@agent-desktop/log';

const log = createLogger({ service: 'agentd' });
const warnedMissingScope = new Set<string>();

export async function withSlackExternal(fetchFn: typeof fetch, token: string | undefined, event: ChannelInboundEvent): Promise<ChannelInboundEvent> {
  if (event.chatType !== 'group' || token === undefined) return event;
  const answer = await slackChannelExternal(fetchFn, token, event.chatId);
  if (answer.missingScope && !warnedMissingScope.has(event.chatId)) {
    warnedMissingScope.add(event.chatId);
    log.warn({ channel: event.chatId }, 'slack conversations.info refused (missing channels:read / groups:read): the group is treated as internal');
  }
  return { ...event, external: answer.external };
}
