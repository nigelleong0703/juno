import type { AgentEvent } from '@agent-desktop/public-contracts';

/** Durable event log → live subscribers (agentd's SSE). */
export interface StoredEvent {
  id: number;
  event: AgentEvent;
  at: string;
}
export interface EventBus {
  /** Owner-filtered durable replay and live tail; required by account-mode HTTP. */
  forOwner?(ownerId: string): EventBus;
  /** Events with id > afterId, oldest first (for Last-Event-ID replay). */
  since(afterId: number, limit?: number): Promise<StoredEvent[]>;
  /**
   * Highest visible event id in the durable log (0 when empty). The id counter is global across owners,
   * so this is not owner-filtered; callers that expose it must document that. Not a replay position on its
   * own: a lower id can still commit after this returns (see agentd's cursor margin).
   */
  head?(): Promise<number>;
  /** Live tail (LISTEN/NOTIFY); returns unsubscribe. */
  subscribe(onEvent: (e: StoredEvent) => void): Promise<() => void>;
  /** Deletes durable events created before `before` (all owners: retention is global) and returns how many went. */
  prune(before: Date): Promise<number>;
}
