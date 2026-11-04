/**
 * The `delivery` health entry (BACKEND 5.7.11): a channel (one platform bot or app, or one platform's push) that failed three tries in a row turns
 * the entry red until a send through it succeeds. Kept in memory by the sender, which is the only process that sends; a restart starts green and a
 * channel that is still broken turns red again after three tries. Owner-visible in `GET /v1/outbox` (only that owner's channels), operator-visible in
 * `GET /internal/health` (all of them).
 */
export const RED_AFTER_FAILURES = 3;

export interface FailingChannel {
  ownerId: string;
  /** The platform ("telegram", "slack", "ios"). */
  platform: string;
  /** The connected bot or app (a channel id), or "push". */
  channelId: string;
  consecutiveFailures: number;
  lastError: string;
  since: string;
}

export interface DeliveryHealth {
  status: 'ok' | 'red';
  failing: FailingChannel[];
}

export interface HealthTracker {
  success(ownerId: string, platform: string, channelId: string): void;
  failure(ownerId: string, platform: string, channelId: string, error: string, at: string): void;
  /** Every channel at or past the threshold; one owner's only when `ownerId` is given. */
  report(ownerId?: string): DeliveryHealth;
}

export function createHealthTracker(): HealthTracker {
  const channels = new Map<string, FailingChannel>();
  const key = (ownerId: string, platform: string, channelId: string): string => [ownerId, platform, channelId].join('|');
  return {
    success: (ownerId, platform, channelId) => { channels.delete(key(ownerId, platform, channelId)); },
    failure(ownerId, platform, channelId, error, at) {
      const id = key(ownerId, platform, channelId);
      const before = channels.get(id);
      channels.set(id, { ownerId, platform, channelId, consecutiveFailures: (before?.consecutiveFailures ?? 0) + 1, lastError: error, since: before?.since ?? at });
    },
    report(ownerId) {
      const failing = [...channels.values()].filter((entry) => entry.consecutiveFailures >= RED_AFTER_FAILURES && (ownerId === undefined || entry.ownerId === ownerId));
      return { status: failing.length > 0 ? 'red' : 'ok', failing };
    },
  };
}
