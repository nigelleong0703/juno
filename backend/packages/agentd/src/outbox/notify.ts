/**
 * The agent learns when its message did not arrive (BACKEND 5.7.11). When a row is dropped for a reason that is a failure, one system wake goes into
 * that conversation's session: "[delivery failed] Your message in <chat> was not delivered: <reason>. It will not arrive; do not claim it was sent."
 * It is a trusted system note that nobody waits on (run-origin.ts `isUnattendedStartWake`), so the agent decides whether to tell the owner, through
 * `send_message`. One wake per row: the wake id is the row id, and the row remembers it was told.
 *
 * A reply to this wake that is itself dropped (the same dead chat) does not wake the agent again: that would be a loop.
 */
import { sessionKey, type Enqueuer, type Store, type WakeEvent } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import type { OutboxRow } from 'juno-agent/contracts';
import type { ChannelRegistry } from '../channels/registry.js';
import { runWithOwner } from '../owner-scope.js';
import { FAILURE_REASONS } from './rows.js';

const log = createLogger({ service: 'agentd' });

/** The label of the wake's origin; also how a run started by it is recognised. */
export const DELIVERY_FAILED_LABEL = 'delivery failed';

const REASON_TEXT: Record<string, string> = {
  retries_exhausted: 'the platform kept failing and delivery was given up after several tries',
  channel_gone: 'the chat is gone or the bot was removed from it',
  token_invalid: 'the platform no longer accepts the connection to it',
  content_rejected: 'the platform refused this message',
};

/** What the dropped row was: "your message in the Telegram group chat", "the file report.pdf you made, in the Slack private chat". */
function whatAndWhere(row: OutboxRow, channels: ChannelRegistry): string {
  const destination = row.destination;
  if (destination.type === 'push') return 'a notification to the owner\'s phone';
  const origin = destination.origin;
  const platform = channels.displayName({ kind: origin.kind });
  const where = `the ${platform} ${origin.chatType === 'group' ? 'group' : 'private'} chat`;
  if (destination.type === 'output') return `the file "${destination.name}" you made, in ${where}`;
  return row.kind === 'channel_request_card' ? `your question in ${where}` : `your message in ${where}`;
}

export function deliveryFailedText(row: OutboxRow, channels: ChannelRegistry): string {
  const reason = REASON_TEXT[row.droppedReason ?? 'retries_exhausted'] ?? 'it could not be delivered';
  return `[delivery failed] ${whatAndWhere(row, channels).replace(/^./, (c) => c.toUpperCase())} was not delivered: ${reason}. It will not arrive; do not claim it was sent.`;
}

/** Tell the agent about a dropped row, once. Never throws; the row is marked told whether or not a wake was due. */
export async function notifyDropped(deps: { store: Store; enqueuer: Enqueuer; channels: ChannelRegistry }, row: OutboxRow): Promise<void> {
  try {
    if (row.agentNotified === true) return;
    await deps.store.put('outbox', { ...row, agentNotified: true });
    const { ownerId, agentId, conversationId, droppedReason } = row;
    if (row.destination.type === 'push' || ownerId === undefined || agentId === undefined || conversationId === undefined) return;
    if (droppedReason === undefined || !FAILURE_REASONS.includes(droppedReason)) return;
    // A reply written in answer to a delivery-failed wake does not wake the agent about itself.
    const run = row.runId === undefined ? null : await deps.store.get('runs', row.runId);
    if (run?.origin?.type === 'system' && run.origin.label === DELIVERY_FAILED_LABEL) return;
    const event: WakeEvent = {
      id: 'delivery-failed:' + row.id,
      ownerId, agentId, conversationId,
      sessionKey: sessionKey(agentId, conversationId),
      kind: 'hand_back',
      origin: { type: 'system', label: DELIVERY_FAILED_LABEL },
      trusted: true,
      priority: 'background',
      payload: { source: 'delivery_failed', text: deliveryFailedText(row, deps.channels), rowId: row.id },
      at: new Date().toISOString(),
      status: 'accepted',
    };
    const result = await runWithOwner(ownerId, () => deps.enqueuer.enqueue(event)).catch((error: unknown) => ({ accepted: false, reason: String(error) }));
    if (!result.accepted) log.warn({ rowId: row.id, reason: result.reason }, 'delivery-failed note not delivered to the agent');
  } catch (err) {
    log.warn({ err, rowId: row.id }, 'telling the agent about a dropped delivery failed');
  }
}
