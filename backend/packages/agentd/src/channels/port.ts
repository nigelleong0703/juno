/**
 * The chat tools' way to the platforms (`react`, `channel_history`): the ChannelPort juno-agent calls, answered with the platform's
 * abilities (packages/channels) and the credentials of the channel the run's chat came through. The tools have already checked the
 * chat's capability row; a platform without the ability still answers `unsupported`.
 */
import type { ChannelRow, Store } from '@agent-desktop/contracts';
import type { ChannelOrigin } from '@agent-desktop/public-contracts';
import type { AdapterAuth, ChannelAbilities } from '@agent-desktop/channels/abilities';
import type { ChannelPort } from 'juno-agent/modules/tools/tools/channelHistory';
import { readsChatHistory } from 'juno-agent/modules/channel-origin';
import { scoped } from '../meetings/session.js';
import { docOwnerId } from '../routes/relationships.js';
import { openChannelRow } from './credentials.js';
import { readChatHistory } from './history.js';
import type { ChannelRegistration } from './registration.js';
import type { ChannelRegistry } from './registry.js';

export interface ChatAccess {
  row: ChannelRow;
  auth: AdapterAuth;
  abilities: ChannelAbilities;
  /** The platform's registration: its outcome hook takes what a call's result says about the channel's grants. */
  registration: ChannelRegistration;
}

/** The platform chat of an origin: its channel row (the owner's own), the opened credentials and the abilities of the platform's plugin; undefined when any is missing (a disabled platform plugin included). */
export async function chatAccess(store: Store, channels: ChannelRegistry, ownerId: string, origin: ChannelOrigin): Promise<ChatAccess | undefined> {
  const row = await scoped(store, ownerId).get('channels', origin.kind + ':' + origin.channelId);
  const registration = channels.get(origin.kind);
  const abilities = registration?.adapter.abilities;
  if (row === null || registration === undefined || abilities === undefined || docOwnerId(row) !== ownerId) return undefined;
  const opened = await openChannelRow(scoped(store, ownerId), row);
  return 'error' in opened ? undefined : { row, auth: registration.adapter.identity.authOf(opened.channel), abilities, registration };
}

export function createChannelPort(deps: { store: Store; channels: ChannelRegistry; channelFetch?: typeof fetch }): ChannelPort {
  const fetchFn = deps.channelFetch ?? fetch;
  return {
    async react({ ownerId, origin, messageId, emoji }) {
      const chat = await chatAccess(deps.store, deps.channels, ownerId, origin);
      if (chat === undefined) return { status: 'unsupported' };
      const result = await chat.abilities.react(fetchFn, chat.auth, { chatId: origin.chatId, messageId }, emoji);
      // A platform whose grants follow its answers (Feishu: a reaction that works means the reactions scope was granted) records the outcome.
      await chat.registration.abilityOutcome?.(scoped(deps.store, ownerId), chat.row, 'react', result);
      return result;
    },
    async sendFile({ ownerId, origin, file }) {
      const chat = await chatAccess(deps.store, deps.channels, ownerId, origin);
      if (chat === undefined) return { status: 'unsupported' };
      return chat.abilities.sendFile(fetchFn, chat.auth, { chatId: origin.chatId, threadId: origin.threadId ?? origin.chatId }, file);
    },
    async history({ ownerId, origin, beforeId, beforeAt, limit }) {
      const chat = await chatAccess(deps.store, deps.channels, ownerId, origin);
      if (chat === undefined) return { status: 'unsupported' };
      // The owner's switch (permission tier `readHistory`): off means no earlier message is read for anyone, the tool and the group note alike.
      if (!readsChatHistory(await scoped(deps.store, ownerId).get('agents', chat.row.agentId))) return { status: 'skipped', reason: 'Your owner turned off reading earlier messages for this agent.' };
      const found = await readChatHistory({ store: scoped(deps.store, ownerId), channels: deps.channels, ...(deps.channelFetch === undefined ? {} : { channelFetch: deps.channelFetch }) }, chat.row, { chatId: origin.chatId, threadId: origin.threadId ?? origin.chatId, limit, ...(beforeId === undefined ? {} : { beforeId }), ...(beforeAt === undefined ? {} : { beforeAt }) });
      // The same for a read (Feishu: a read that works means the group-message scope was granted).
      await chat.registration.abilityOutcome?.(scoped(deps.store, ownerId), chat.row, 'history', found);
      return found;
    },
  };
}
