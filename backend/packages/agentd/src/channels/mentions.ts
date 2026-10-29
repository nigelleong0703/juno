/**
 * Who a message's mentions are, decided by platform id only (display names can be changed by anyone): the owner, or another agent
 * of the same owner on this platform. Anyone else is left out; the text already reads `@Name` for them. The result goes into the
 * wake payload as neutral data and the agent runtime renders it; it never sees platform syntax.
 */
import type { ChannelRow, Store } from '@agent-desktop/contracts';
import type { ChannelPerson } from '@agent-desktop/channels/types';

export interface MentionNote {
  id: string;
  name: string;
  handle?: string;
  role: 'owner' | 'agent';
}

export async function classifyMentions(store: Store, channel: ChannelRow, mentions: ChannelPerson[] | undefined): Promise<MentionNote[]> {
  if (mentions === undefined || mentions.length === 0) return [];
  const notes: MentionNote[] = [];
  let agentRows: ChannelRow[] | undefined;
  for (const person of mentions) {
    const base = { id: person.id, name: person.name, ...(person.handle === undefined ? {} : { handle: person.handle }) };
    if (channel.ownerExternalId !== undefined && person.id === channel.ownerExternalId) {
      notes.push({ ...base, role: 'owner' });
      continue;
    }
    agentRows ??= (await store.list('channels', { where: { kind: channel.kind }, limit: 500 })).items.filter((row) => row.ownerId === channel.ownerId && row.botUserId !== undefined);
    const agentRow = agentRows.find((row) => row.botUserId === person.id);
    const agent = agentRow === undefined ? null : await store.get('agents', agentRow.agentId);
    if (agent) notes.push({ ...base, name: agent.name, role: 'agent' });
  }
  return notes;
}
