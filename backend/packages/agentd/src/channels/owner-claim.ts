/**
 * "Is this you?" (owner binding fallback): when the platform could not tell us who the owner is, the first
 * private message to an unbound channel is held and the owner confirms in the Juno app.
 *
 * The prompt is a `question` request with two choices on the app's existing decision cards. The held message
 * rides on the request (`channelClaim`), at most one per sender while a prompt is open. "It's me" binds the
 * sender and admits the held message as the owner's; "Not me" remembers the id on the row
 * (`declinedExternalIds`) and admits it as a stranger's. The bot never answers the sender in the meantime and
 * never mentions a code.
 */
import { randomUUID } from 'node:crypto';
import type { ChannelClaim, ChannelRow, StoredRequest } from '@agent-desktop/contracts';
import { channelRowId } from '@agent-desktop/contracts';
import type { Request } from '@agent-desktop/public-contracts';
import { withFallbackText } from '@agent-desktop/public-contracts';
import { emitAgentStatus } from 'juno-agent/execution/agent-status';
import { admitChannelEvent, type AdmitDeps, type AdmitResult, type IncomingChannelEvent } from '../routes/channels.js';
import { recordIngressSender } from './people.js';

export const CLAIM_CHOICES_ID = 'confirm';
export const CLAIM_ME = 'me';
export const CLAIM_NOT_ME = 'not_me';

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

async function pendingClaims(deps: AdmitDeps, agentId: string): Promise<StoredRequest[]> {
  const page = await deps.store.list('requests', { where: { agentId, kind: 'question', status: 'pending' }, limit: 100 });
  return page.items.filter((request) => (request as StoredRequest).channelClaim !== undefined) as StoredRequest[];
}

/**
 * Called for every admitted event of a channel. Returns the result to answer with when the event is held for the
 * owner's confirmation, or null when it should be admitted normally (bound channel, group chat, declined sender).
 */
export async function holdForOwnerConfirmation(
  deps: AdmitDeps,
  ownerId: string,
  channel: ChannelRow,
  agentName: string,
  event: IncomingChannelEvent,
): Promise<AdmitResult | null> {
  const externalId = event.from?.id;
  if (channel.ownerExternalId !== undefined || event.chatType !== 'private' || externalId === undefined) return null;
  if (channel.declinedExternalIds?.includes(externalId) === true) return null;
  const open = await pendingClaims(deps, channel.agentId);
  const held = open.some((request) => request.channelClaim?.kind === channel.kind && request.channelClaim.channelId === channel.channelId && request.channelClaim.externalId === externalId);
  if (held) return { status: 200, body: { received: false, held: true } };
  const platform = deps.channels.displayName(channel);
  const who = oneLine(event.from?.name ?? '', 60) || externalId;
  const bot = deps.channels.get(channel.kind)?.adapter.identity.botLabel(channel, agentName) ?? agentName;
  const claim: ChannelClaim = {
    kind: channel.kind,
    channelId: channel.channelId,
    externalId,
    event: {
      chatType: event.chatType,
      text: event.text,
      ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      ...(event.chatId === undefined ? {} : { chatId: event.chatId }),
      ...(event.externalMessageId === undefined ? {} : { externalMessageId: event.externalMessageId }),
      from: { id: externalId, ...(event.from?.name === undefined ? {} : { name: event.from.name }) },
    },
  };
  const request: Request & { ownerId: string; channelClaim: ChannelClaim } = {
    id: 'req-' + randomUUID(),
    kind: 'question',
    status: 'pending',
    title: oneLine('Is this you? ' + platform + ' user ' + who + ' messaged ' + bot, 200),
    summary: 'If it is you, Juno will treat your messages there as your own instructions.',
    agentId: channel.agentId,
    payload: {
      kind: 'question',
      ui: withFallbackText({
        version: 1,
        blocks: [
          {
            type: 'facts',
            rows: [
              { label: 'Platform', value: platform },
              { label: 'From', value: who + (who === externalId ? '' : ' (' + oneLine(externalId, 40) + ')') },
              { label: 'Message', value: oneLine(event.text, 120) || '(no text)' },
            ],
          },
          {
            type: 'choices',
            id: CLAIM_CHOICES_ID,
            options: [
              { id: CLAIM_ME, label: "It's me", style: 'primary' },
              { id: CLAIM_NOT_ME, label: 'Not me' },
            ],
          },
        ],
      }),
    },
    createdAt: new Date().toISOString(),
    ownerId,
    channelClaim: claim,
  };
  await deps.store.put('requests', request);
  const { channelClaim: _held, ownerId: _owner, ...visible } = request;
  await deps.store.emit({ type: 'request.created', request: visible });
  await emitAgentStatus(deps.store, channel.agentId);
  return { status: 200, body: { received: false, held: true } };
}

/**
 * The owner answered: bind or decline the sender, then admit the held message through the normal path (as the
 * owner's, or as a stranger's). A retried delivery re-runs this; the item and wake ids are deterministic.
 */
export async function settleOwnerClaim(deps: AdmitDeps, ownerId: string, request: StoredRequest): Promise<void> {
  const claim = request.channelClaim;
  if (claim === undefined) return;
  const answer = request.payload.kind === 'question' ? request.payload.answers?.[CLAIM_CHOICES_ID] : undefined;
  const row = await deps.store.get('channels', channelRowId(claim.kind, claim.channelId));
  if (row === null) return;
  const now = new Date().toISOString();
  if (answer === CLAIM_ME && (row.ownerExternalId === undefined || row.ownerExternalId === claim.externalId)) {
    await deps.store.put('channels', { ...row, ownerExternalId: claim.externalId, updatedAt: now });
    // The owner's account is linked to the owner's person as soon as the owner says it is them.
    await recordIngressSender(deps, ownerId, row, { id: claim.externalId, name: claim.event.from?.name }, { owner: true, createPerson: false });
  } else if (answer === CLAIM_NOT_ME && row.declinedExternalIds?.includes(claim.externalId) !== true) {
    await deps.store.put('channels', { ...row, declinedExternalIds: [...(row.declinedExternalIds ?? []), claim.externalId], updatedAt: now });
  }
  await admitChannelEvent(deps, ownerId, claim.kind, claim.channelId, claim.event);
}
