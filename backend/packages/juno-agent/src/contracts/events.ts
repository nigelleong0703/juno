import type { AgentEvent } from '@agent-desktop/public-contracts';

/** Durable event log → live subscribers (agentd's SSE). */
export interface StoredEvent {
  id: number;
  event: AgentEvent;
  at: string;
}
/**
 * Live run text: published next to the durable log, never stored in it. A text delta of one live model attempt, a reset when a
 * new attempt starts (the consumer discards the partial text of the attempt before it), and the end of a live turn with the
 * number of tool calls it made. Replays of a journaled attempt publish nothing.
 */
export interface LiveRunScope {
  ownerId: string;
  conversationId: string;
  agentId: string;
  runId: string;
  /** Journal-stable key of the model attempt (`model:N`, `model:N:retry:K`, `model:N:fallback:K`). */
  attempt: string;
}
export type LiveRunEvent =
  | (LiveRunScope & { type: 'run.text.delta'; text: string })
  | (LiveRunScope & { type: 'run.text.reset' })
  | (LiveRunScope & { type: 'run.text.end'; toolCalls: number });

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
  /**
   * Cross-process transport of live run text, used only when the agentd roles are split (a worker publishes, the coordinator subscribes
   * and relays into its in-process hub). No log row is written. One process never uses it: see execution/live-runs.ts.
   */
  publishLive?(batch: LiveRunEvent[]): Promise<void>;
  subscribeLive?(onEvent: (e: LiveRunEvent) => void): Promise<() => void>;
  /** Deletes durable events created before `before` (all owners: retention is global) and returns how many went. */
  prune(before: Date): Promise<number>;
}
