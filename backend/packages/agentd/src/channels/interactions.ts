/**
 * A tap on a platform button (Telegram callback, Slack block action, Discord component, Feishu card action), platform-neutral.
 *
 * The token names a stored item or request (see render.ts), so the tap is re-read from the store: the option, the pending
 * state and the channel it belongs to all come from there, never from the platform payload. A quick reply or a question's
 * option becomes the user's next message (the same admission as typed text); an approval is decided through the app's own
 * `resolveRequest`. Deciding a request is the owner's alone: anyone else gets `not-owner` and nothing changes.
 */
import { channelRowId, parseStoredRequest } from '@agent-desktop/contracts';
import { uiInteractiveBlock } from '@agent-desktop/public-contracts';
import type { ChannelOrigin } from '@agent-desktop/public-contracts';
import type { ClickOutcome, ParsedClick } from '@agent-desktop/channels/click';
import { runWithOwner } from 'juno-agent/owner-context';
import { admitChannelEvent, speakerFor, type AdmitDeps } from '../routes/channels.js';
import { openChannelRow } from './credentials.js';
import { originOfItem, originOfRequest } from './origin.js';
import { docOwnerId } from '../routes/relationships.js';
import { resolveRequest } from '../routes/requests.js';
import { parseButtonToken, richFromItem, richFromRequest, type RichMessage } from '@agent-desktop/channels/render';

const stale = (reason: string): ClickOutcome => ({ status: 'stale', reason });

/**
 * One tap in the platform's own payload (`raw`: a Slack form `payload`, a Telegram update, a Discord gateway event, a Feishu card
 * action): the platform's adapter parses it, the store decides what it means (`handleChannelClick`) and the parsed click answers on
 * the platform. `handled: false`: not a tap of ours. `response`: the body a platform answers with in its own HTTP response (Feishu).
 */
export async function answerChannelClick(deps: AdmitDeps, ownerId: string, kind: string, channelId: string, raw: unknown): Promise<{ handled: boolean; response?: Record<string, unknown> }> {
  const click = deps.channels.get(kind)?.adapter.inbound.parseClick(raw);
  if (click === undefined) return { handled: false };
  const outcome: ClickOutcome = click.inert === true ? { status: 'inert' } : await runWithOwner(ownerId, () => handleChannelClick(deps, ownerId, kind, channelId, click));
  const opened = await openChannelRow(deps.store, await deps.store.get('channels', channelRowId(kind, channelId)));
  const redraw = click.redraws === true && outcome.status === 'done' ? await richForToken(deps, click.token) : undefined;
  const response = await click.ack({ fetchFn: deps.channelFetch ?? fetch, token: 'error' in opened ? undefined : opened.channel.botToken, ...(redraw === undefined ? {} : { redraw }) }, outcome);
  return { handled: true, ...(response === undefined ? {} : { response }) };
}

export async function handleChannelClick(deps: AdmitDeps, ownerId: string, kind: string, channelId: string, click: Pick<ParsedClick, 'token' | 'from'>): Promise<ClickOutcome> {
  const token = parseButtonToken(click.token);
  if (token === undefined) return stale('unknown button');
  const channel = await deps.store.get('channels', channelRowId(kind, channelId));
  if (!channel || docOwnerId(channel) !== ownerId) return stale('channel not found');
  const isOwner = speakerFor(channel.ownerExternalId, click.from.id) === 'owner';

  // A button belongs to this channel when the message it sits on was delivered here (its origin), not by where its conversation lives.
  const here = (origin: ChannelOrigin | undefined): ChannelOrigin | undefined => (origin !== undefined && origin.kind === kind && origin.channelId === channelId ? origin : undefined);

  if (token.kind === 'item') {
    const item = await deps.store.get('items', token.id);
    if (!item || item.type !== 'agent_message') return stale('message not found');
    const conv = await deps.store.get('conversations', item.conversationId);
    const where = conv === null ? undefined : here(originOfItem(item, conv));
    const block = item.ui?.blocks.find((candidate) => candidate.type === 'replies');
    const label = block?.type === 'replies' ? block.options[token.index] : undefined;
    if (where === undefined || label === undefined) return stale('option not found');
    const result = await admitChannelEvent(deps, ownerId, kind, channelId, {
      chatId: where.chatId,
      ...(where.threadId === undefined ? {} : { threadId: where.threadId }),
      chatType: where.chatType ?? 'private',
      // One tap per message: a second button on the same message is refused as a different answer.
      externalMessageId: 'btn:' + item.id,
      from: click.from,
      text: label,
      replyToItemId: item.id,
    });
    return result.status === 202 ? { status: 'done', label } : stale('already answered');
  }

  const found = await deps.store.get('requests', token.id);
  if (!found) return stale('request not found');
  const request = parseStoredRequest(found);
  if (docOwnerId(found) !== ownerId || here((await originOfRequest(deps.store, found))?.origin) === undefined) return stale('request not found');
  if (request.status !== 'pending') return stale('already decided');
  if (!isOwner) return { status: 'not-owner' };

  if (token.kind === 'approval') {
    if (request.payload.kind !== 'approval' || token.index > 1) return stale('not an approval');
    const approve = token.index === 0;
    const outcome = await resolveRequest(deps, ownerId, request.id, { action: approve ? 'approve' : 'deny' });
    return outcome.status === 200 ? { status: 'done', label: approve ? 'Approved' : 'Denied' } : stale('could not be decided');
  }

  if (request.payload.kind !== 'question') return stale('not a question');
  const block = uiInteractiveBlock(request.payload.ui);
  const option = block?.type === 'choices' && block.multiple !== true ? block.options[token.index] : undefined;
  if (block?.type !== 'choices' || option === undefined) return stale('option not found');
  const outcome = await resolveRequest(deps, ownerId, request.id, { action: 'answer', answers: { [block.id]: option.id } });
  return outcome.status === 200 ? { status: 'done', label: option.label } : stale('could not be answered');
}

/** The message a button belongs to, rebuilt from the store (for a platform that must redraw the card on a tap). */
export async function richForToken(deps: Pick<AdmitDeps, 'store'>, token: string): Promise<RichMessage | undefined> {
  const parsed = parseButtonToken(token);
  if (parsed === undefined) return undefined;
  if (parsed.kind === 'item') {
    const item = await deps.store.get('items', parsed.id);
    return item?.type === 'agent_message' ? richFromItem(item) : undefined;
  }
  const request = await deps.store.get('requests', parsed.id);
  return request === null ? undefined : richFromRequest(parseStoredRequest(request));
}
