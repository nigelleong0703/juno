/**
 * Discord's outbound hooks (ChannelRegistration.delivery): the two things a Discord reply needs beyond the text.
 *  - a role mention: "@New agent" written by an agent on the shared Discord bot becomes that agent's role mention, the form a
 *    person uses and the one that wakes it (shared.ts admitAgentPost). Only other agents of this installation; longest names first;
 *  - a receipt per posted message (`discord-sent:<messageId>`): which agent and run wrote it, so a later role mention in that message
 *    can wake the other agent.
 */
import type { Store } from '@agent-desktop/contracts';
import type { ChannelDeliveryHooks } from '../registration.js';

export const DISCORD_SENT_TYPE = 'discord-sent';

/** The record of one Discord message our agent posted (`discord-sent:<messageId>`): who wrote it (agent, run) and which item it was. */
export function sentMessageReceipt(messageId: string, conversationId: string, item: { id: string; agentId: string; runId?: string }, now: string) {
  return {
    id: DISCORD_SENT_TYPE + ':' + messageId,
    agentId: item.agentId,
    conversationId,
    runId: item.runId ?? conversationId,
    source: 'channel',
    type: DISCORD_SENT_TYPE,
    eventId: item.id,
    consumedAt: now,
    createdAt: now,
  };
}

async function agentRoleMentions(store: Store, installationId: string, senderAgentId: string, text: string): Promise<string> {
  const rows = (await store.list('channels', { where: { kind: 'discord' }, limit: 200 })).items
    .filter((row) => row.installationId === installationId && row.agentId !== senderAgentId && row.roleId !== undefined && (row.handle ?? '') !== '')
    .sort((a, b) => (b.handle ?? '').length - (a.handle ?? '').length);
  let out = text;
  for (const row of rows) {
    const name = (row.handle ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('@' + name + '(?![\\w-])', 'gi'), '<@&' + String(row.roleId) + '>');
  }
  return out;
}

export const discordDelivery: ChannelDeliveryHooks = {
  prepareText: ({ store, installationId, senderAgentId, text }) => agentRoleMentions(store, installationId, senderAgentId, text),
  async sent({ store, conversationId, item, externalIds, now }) {
    for (const messageId of externalIds) await store.put('eventReceipts', sentMessageReceipt(messageId, conversationId, item, now));
  },
};
