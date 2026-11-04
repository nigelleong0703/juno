/**
 * Storage shapes of the outbox (BACKEND 5.7.11): one durable row per (destination, message) that has to leave the platform, and the owner's
 * freeze switch. Internal: clients see `OutboxEntry` / `DeliveryState` from public-contracts, never these rows.
 */
import type { ChannelOrigin, OutboxDroppedReason, OutboxKind, OutboxStatus } from '@agent-desktop/public-contracts';

/** A notification as the phone shows it, kept on the row so a retry (or a restart) sends exactly what the first try would have. */
export interface OutboxPushNotice {
  title: string;
  body: string;
  data: Record<string, string>;
}

export type OutboxDestination =
  /** A reply bubble or a question card: the platform chat the run answered in. */
  | { type: 'channel'; origin: ChannelOrigin }
  /** A document a run made, posted into the thread its answer went to. */
  | { type: 'output'; origin: ChannelOrigin; docId: string; version: number; fileRef: string; name: string; mimeType: string }
  /** One registered phone. */
  | { type: 'push'; deviceId: string; notice: OutboxPushNotice };

export interface OutboxRow {
  /** Deterministic from kind, source and destination, so the same delivery is never queued twice. */
  id: string;
  ownerId?: string;
  conversationId?: string;
  agentId?: string;
  runId?: string;
  kind: OutboxKind;
  /** The item, request or document version (`docId:version`) being delivered; a push: the request or run that raised it. */
  sourceId: string;
  destination: OutboxDestination;
  /** The platform kind ("telegram", "slack") or "ios" / "android". */
  platform: string;
  status: OutboxStatus;
  attempts: number;
  /** Not before this time (ISO); a pending row whose time has come is the sender's next job. */
  nextAttemptAt: string;
  /** Written before a send starts and cleared with its result: a row found with it set after a restart may have been sent (at-least-once). */
  attemptingAt?: string;
  /** One line, secrets removed. */
  lastError?: string;
  droppedReason?: OutboxDroppedReason;
  externalId?: string;
  /** Ordering key within a conversation: the source's own time (an item's `at`), not the time the row was made. */
  at: string;
  createdAt: string;
  sentAt?: string;
  droppedAt?: string;
  /** The agent was told this row was dropped (one wake per row). */
  agentNotified?: boolean;
}

/** The owner's switch: while `frozen`, nothing of theirs leaves (BACKEND 5.7.11). One row per owner, id = the owner id. */
export interface OutboxControl {
  id: string;
  ownerId?: string;
  frozen: boolean;
  updatedAt: string;
}
