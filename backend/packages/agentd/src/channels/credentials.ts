/**
 * The row a platform call is made with. A per-agent bot carries its own sealed token; an agent on the shared Juno app / bot speaks
 * with the token of its installation (workspace / server). Opening happens just before a send, never earlier.
 */
import type { ChannelInstallation, ChannelRow, Store } from '@agent-desktop/contracts';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import type { SenderIdentity } from '@agent-desktop/channels/types';

export interface OpenedChannel {
  channel: ChannelRow;
  installation?: ChannelInstallation;
}

export async function openChannelRow(store: Store, row: ChannelRow | null): Promise<OpenedChannel | { error: string }> {
  if (!row) return { error: 'Channel not found' };
  try {
    if (row.installationId !== undefined) {
      const installation = await store.get('channelInstallations', row.installationId);
      if (!installation) return { error: 'The workspace installation is gone' };
      return {
        channel: { ...row, botToken: decryptSecret(installation.botToken), botUserId: installation.botUserId, teamId: installation.teamId },
        installation,
      };
    }
    if (typeof row.botToken !== 'string' || row.botToken.length === 0) return { error: 'Channel send is not configured' };
    return { channel: { ...row, botToken: decryptSecret(row.botToken) } };
  } catch {
    return { error: 'Channel credential could not be opened' };
  }
}


const CHARACTERS =['star', 'bean', 'mint', 'blue', 'purple', 'pink'];

/** Optional CHANNELS_AVATAR_BASE_URL serves `<character>.png` images for agents; without it only the name is customised. */
export function avatarUrlFor(agent: { id: string; avatar?: { character?: string } }): string | undefined {
  const base = process.env['CHANNELS_AVATAR_BASE_URL']?.trim().replace(/\/+$/, '');
  if (base === undefined || base === '') return undefined;
  let hash = 0;
  for (const ch of agent.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return base + '/' + (agent.avatar?.character ?? CHARACTERS[hash % CHARACTERS.length]) + '.png';
}

export async function identityOf(store: Store, row: ChannelRow): Promise<SenderIdentity | undefined> {
  if (row.installationId === undefined) return undefined;
  const agent = await store.get('agents', row.agentId);
  if (!agent) return undefined;
  const iconUrl = avatarUrlFor(agent);
  return { name: agent.name, ...(iconUrl === undefined ? {} : { iconUrl }) };
}
