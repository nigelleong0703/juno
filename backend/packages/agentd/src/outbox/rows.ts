/**
 * The outbox rows (BACKEND 5.7.11): ids, creation and the few state changes a row goes through. A row id is made from the kind and the source
 * (an item, a question, a document version, a phone), so the same delivery is never queued twice however many times something offers it.
 * The sender is the only writer of a row after it exists; the owner's retry is the one other change (dropped back to pending once).
 */
import type { Store } from '@agent-desktop/contracts';
import type { OutboxDroppedReason, OutboxKind } from '@agent-desktop/public-contracts';
import type { OutboxDestination, OutboxRow } from 'juno-agent/contracts';

export const replyRowId = (itemId: string): string => 'obx:reply:' + itemId;
export const cardRowId = (requestId: string): string => 'obx:card:' + requestId;
export const outputRowId = (docId: string, version: number): string => 'obx:out:' + docId + ':' + String(version);
export const pushRowId = (sourceId: string, deviceId: string): string => 'obx:push:' + sourceId + ':' + deviceId;

/** Tries before a transient failure is given up on, and the wait before try n+1: 5 s, doubling, at most 5 minutes. */
export const MAX_ATTEMPTS = 8;
export const BACKOFF_FIRST_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const backoffMs = (attempts: number): number => Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

/** The reasons that tell the agent: its message did not arrive. `source_gone` and `superseded` are not failures of delivery. */
export const FAILURE_REASONS: readonly OutboxDroppedReason[] = ['retries_exhausted', 'channel_gone', 'token_invalid', 'content_rejected'];

export interface NewRow {
  id: string;
  ownerId: string;
  conversationId?: string;
  agentId?: string;
  runId?: string;
  kind: OutboxKind;
  sourceId: string;
  destination: OutboxDestination;
  platform: string;
  /** The source's own time, the order within a conversation. */
  at: string;
}

/** Make the row unless it exists already (sent and dropped rows count: a delivery is queued once, ever). True when this call made it. */
export async function enqueueRow(store: Store, input: NewRow, now: string): Promise<boolean> {
  if ((await store.get('outbox', input.id)) !== null) return false;
  const row: OutboxRow = {
    id: input.id,
    ownerId: input.ownerId,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    kind: input.kind,
    sourceId: input.sourceId,
    destination: input.destination,
    platform: input.platform,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    at: input.at,
    createdAt: now,
  };
  await store.put('outbox', row);
  return true;
}

/** One redacted line: the first line of the message, secrets that look like tokens or long ids removed, 200 characters at most. */
export function oneLine(error: string): string {
  return (error.split('\n')[0] ?? '')
    .replace(/(bot|xox[a-z]-|Bearer\s+)[A-Za-z0-9:_\-.]{12,}/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 200);
}
