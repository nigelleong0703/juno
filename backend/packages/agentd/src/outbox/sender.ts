/**
 * The outbox sender (BACKEND 5.7.11). It runs only in the coordinator process (the one holding the instance lock, §2.2c), takes the pending rows
 * oldest first and tries each one, so a delivery is never lost to a restart or a failed call.
 *
 * Order: within one conversation strictly in order. A row that is still retrying holds back every later row of its conversation (a reply must not
 * overtake the one before it); different conversations go in parallel, at most `CONCURRENCY` at a time. After a send, the next reply of the same
 * run waits out its reading pause (the same beat the app uses between bubbles), so bubbles that were released together still arrive one by one.
 *
 * Failures: transient ones (network, 5xx, 429 with the platform's own wait) retry with backoff 5 s doubling to 5 min, up to 8 tries, then the row
 * is dropped as `retries_exhausted`. Permanent ones drop at once (`channel_gone`, `token_invalid`, `content_rejected`); a platform whose plugin is
 * off makes the row WAIT (it stays pending, nothing is counted) until the plugin is back. A dropped row tells the agent once (notify.ts).
 *
 * At-least-once: `attemptingAt` is written before the platform call and cleared with its result. A crash in between leaves the mark, and the send is
 * tried again after the restart, so such a message can arrive twice unless the platform recognises the repeat (Discord and Feishu do, see channels/).
 *
 * Freeze: while `OUTBOX_FROZEN` is set (the operator) or the owner switched sending off, nothing leaves; rows stay pending and go out in order afterwards.
 */
import type { BlobStore, Enqueuer, Store } from '@agent-desktop/contracts';
import { channelRowId } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import type { OutboxRow } from 'juno-agent/contracts';
import { readingPauseMs } from 'juno-agent/execution/harness/services/reply-layout';
import type { OutboxDroppedReason } from '@agent-desktop/public-contracts';
import { deliverChannelReply, deliverChannelRequest, type ChannelDeliveryOutcome, type ChannelSenders } from '../channels/delivery.js';
import { sendOutputRow, type OutputDeps } from '../channels/outputs.js';
import type { ChannelRegistry } from '../channels/registry.js';
import { sendPushRow, type PushSenders } from '../push/notifier.js';
import { createHealthTracker, type DeliveryHealth } from './health.js';
import { announceDelivery } from './delivery-state.js';
import { notifyDropped } from './notify.js';
import { backoffMs, MAX_ATTEMPTS, oneLine } from './rows.js';

const log = createLogger({ service: 'agentd' });

const CONCURRENCY = 4;
const TICK_MS = 2_000;
/** A platform whose plugin is off is looked at again this often; waiting costs no try. */
const WAIT_MS = 30_000;
const PAGE = 500;
const PRUNE_EVERY_MS = 60 * 60_000;
const KEEP_SENT_MS = 14 * 24 * 60 * 60_000;
const KEEP_DROPPED_MS = 30 * 24 * 60 * 60_000;

export interface OutboxSenderDeps {
  /** The unscoped store: the sender serves every owner. */
  store: Store;
  senders: ChannelSenders;
  channels: ChannelRegistry;
  blobs: BlobStore;
  channelFetch?: typeof fetch;
  /** Configured push platforms; absent: push rows wait (nothing creates them without a sender). */
  push?: PushSenders;
  enqueuer: Enqueuer;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** No timer: the caller runs `tick()` itself (tests). */
  manual?: boolean;
}

export interface OutboxSender {
  /** Something changed (a row was made, the owner unfroze): look again now. */
  wake(): void;
  /** One pass over the pending rows; resolves when everything due has been tried. Exposed for tests; the timer calls it. */
  tick(): Promise<void>;
  health(ownerId?: string): DeliveryHealth;
  stop(): void;
}

/** The operator's switch: `OUTBOX_FROZEN=1` (or `true`) stops all sending for every owner. */
export const operatorFrozen = (env: NodeJS.ProcessEnv): boolean => ['1', 'true', 'yes'].includes((env['OUTBOX_FROZEN'] ?? '').trim().toLowerCase());

type Attempt = ChannelDeliveryOutcome | { status: 'gone' };

/** The channel a row goes through, for the health entry. */
function channelOf(row: OutboxRow): string {
  const destination = row.destination;
  return destination.type === 'push' ? 'push' : destination.origin.channelId;
}

export function startOutboxSender(deps: OutboxSenderDeps): OutboxSender {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const health = createHealthTracker();
  const outputs: OutputDeps = { store: deps.store, blobs: deps.blobs, channels: deps.channels, ...(deps.channelFetch === undefined ? {} : { channelFetch: deps.channelFetch }) };
  const lastSent = new Map<string, { runId?: string; at: number }>();
  let running = false;
  let again = false;
  let stopped = false;
  let nextPrune = 0;
  let timer: NodeJS.Timeout | undefined;

  const iso = (ms: number): string => new Date(ms).toISOString();

  async function attempt(row: OutboxRow): Promise<Attempt> {
    const ownerId = row.ownerId;
    if (ownerId === undefined) return { status: 'skipped' };
    switch (row.kind) {
      case 'channel_reply':
        if (row.conversationId === undefined) return { status: 'skipped' };
        if ((await deps.store.get('items', row.sourceId)) === null) return { status: 'gone' };
        return deliverChannelReply(deps.store, deps.senders, { ownerId, conversationId: row.conversationId, itemId: row.sourceId, idempotencyKey: row.id });
      case 'channel_request_card':
        if (row.conversationId === undefined) return { status: 'skipped' };
        return deliverChannelRequest(deps.store, deps.senders, { ownerId, conversationId: row.conversationId, requestId: row.sourceId, idempotencyKey: row.id });
      case 'channel_output':
        return sendOutputRow(outputs, row);
      case 'push':
        return deps.push === undefined ? { status: 'failed', error: 'push is not configured', failure: { kind: 'platform_unavailable' } } : sendPushRow({ store: deps.store, senders: deps.push }, row);
    }
  }

  /** Write the result of a try. True when the row is finished (sent or dropped) and the rows behind it may go. */
  async function settle(row: OutboxRow, outcome: Attempt, tried: OutboxRow): Promise<boolean> {
    const at = now();
    const { attemptingAt: _mark, ...rest } = tried;
    const platform = row.platform;
    const owner = row.ownerId ?? '';
    const drop = async (reason: OutboxDroppedReason, error?: string): Promise<boolean> => {
      const dropped: OutboxRow = { ...rest, status: 'dropped', droppedReason: reason, droppedAt: iso(at), ...(error === undefined ? {} : { lastError: oneLine(error) }) };
      await deps.store.put('outbox', dropped);
      log.warn({ rowId: row.id, kind: row.kind, platform, reason, attempts: dropped.attempts }, 'delivery dropped');
      await announceDelivery(deps.store, dropped).catch((err: unknown) => log.warn({ err, rowId: row.id }, 'announcing the delivery state failed'));
      await notifyDropped({ store: deps.store, enqueuer: deps.enqueuer, channels: deps.channels }, dropped);
      return true;
    };
    if (outcome.status === 'sent') {
      await deps.store.put('outbox', { ...rest, status: 'sent', sentAt: iso(at), ...(outcome.externalId === undefined ? {} : { externalId: outcome.externalId }) });
      health.success(owner, platform, channelOf(row));
      if (row.kind === 'channel_reply') lastSent.set(row.conversationId ?? row.id, { ...(row.runId === undefined ? {} : { runId: row.runId }), at });
      return true;
    }
    if (outcome.status === 'gone') return drop('source_gone');
    if (outcome.status === 'skipped') return drop('superseded');
    const error = oneLine(outcome.error);
    const failure = outcome.failure;
    if (failure.kind === 'platform_unavailable') {
      // Waiting is not failing: no try is counted, nothing turns red, and the rows behind this one wait too.
      await deps.store.put('outbox', { ...rest, attempts: row.attempts, lastError: error, nextAttemptAt: iso(at + WAIT_MS) });
      return false;
    }
    health.failure(owner, platform, channelOf(row), error, iso(at));
    if (failure.kind === 'transient') {
      if (tried.attempts >= MAX_ATTEMPTS) return drop('retries_exhausted', outcome.error);
      const wait = Math.max(backoffMs(tried.attempts), failure.retryAfterMs ?? 0);
      await deps.store.put('outbox', { ...rest, lastError: error, nextAttemptAt: iso(at + wait) });
      return false;
    }
    if (failure.kind === 'token_invalid') await markChannelInvalid(row);
    return drop(failure.kind, outcome.error);
  }

  /** The platform refused the credential: the channel row says so (the Apps page shows "reconnect"), as the Telegram poller does. A shared install's token is not one agent's row. */
  async function markChannelInvalid(row: OutboxRow): Promise<void> {
    const destination = row.destination;
    if (destination.type === 'push') return;
    const channel = await deps.store.get('channels', channelRowId(destination.origin.kind, destination.origin.channelId));
    if (channel !== null && channel.installationId === undefined && channel.status !== 'invalid_token') {
      await deps.store.put('channels', { ...channel, status: 'invalid_token', updatedAt: iso(now()) });
    }
  }

  /** Try the head of one conversation's queue, then the next while each finishes. */
  async function runGroup(rows: OutboxRow[]): Promise<void> {
    for (const row of rows) {
      if (stopped || Date.parse(row.nextAttemptAt) > now()) return;
      if (row.kind === 'channel_reply') await pace(row);
      const tried: OutboxRow = { ...row, attempts: row.attempts + 1, attemptingAt: iso(now()) };
      await deps.store.put('outbox', tried);
      let outcome: Attempt;
      try {
        outcome = await attempt(row);
      } catch (error) {
        outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error), failure: { kind: 'transient' } };
      }
      if (!(await settle(row, outcome, tried))) return;
    }
  }

  /** Bubbles of one run arrive one by one: after a send, the next reply of the same run waits its reading pause. */
  async function pace(row: OutboxRow): Promise<void> {
    const previous = lastSent.get(row.conversationId ?? row.id);
    if (previous === undefined || previous.runId !== row.runId) return;
    const item = await deps.store.get('items', row.sourceId);
    const wait = previous.at + readingPauseMs(item?.type === 'agent_message' ? item.markdown : '') - now();
    if (wait > 0) await sleep(wait);
  }

  async function frozenOwners(ownerIds: Iterable<string>): Promise<Set<string>> {
    const frozen = new Set<string>();
    for (const ownerId of ownerIds) if ((await deps.store.get('outboxControl', ownerId))?.frozen === true) frozen.add(ownerId);
    return frozen;
  }

  async function prune(): Promise<void> {
    if (now() < nextPrune) return;
    nextPrune = now() + PRUNE_EVERY_MS;
    for (const [status, keepMs] of [['sent', KEEP_SENT_MS], ['dropped', KEEP_DROPPED_MS]] as const) {
      const old = await deps.store.list('outbox', { where: { status }, orderBy: 'at', order: 'asc', limit: 200 });
      for (const row of old.items) if (Date.parse(row.at) < now() - keepMs) await deps.store.delete('outbox', row.id);
    }
  }

  async function pass(): Promise<void> {
    await prune().catch((err: unknown) => log.warn({ err }, 'outbox prune failed'));
    for (const [key, sent] of lastSent) if (sent.at < now() - 60_000) lastSent.delete(key);
    if (operatorFrozen(deps.env)) return;
    const page = await deps.store.list('outbox', { where: { status: 'pending' }, orderBy: 'at', order: 'asc', limit: PAGE });
    const frozen = await frozenOwners(new Set(page.items.map((row) => row.ownerId ?? '')));
    const groups = new Map<string, OutboxRow[]>();
    for (const row of page.items) {
      if (frozen.has(row.ownerId ?? '')) continue;
      // A push has no order to keep; a chat's deliveries go in the order of their sources.
      const key = row.kind === 'push' ? row.id : row.conversationId ?? row.id;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const queue = [...groups.values()].filter((rows) => Date.parse(rows[0]?.nextAttemptAt ?? '') <= now());
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let rows = queue.shift(); rows !== undefined; rows = queue.shift()) {
        await runGroup(rows).catch((err: unknown) => log.warn({ err }, 'outbox group failed'));
      }
    }));
  }

  async function tick(): Promise<void> {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        await pass();
      } while (again && !stopped);
    } catch (err) {
      log.warn({ err }, 'outbox pass failed');
    } finally {
      running = false;
    }
  }

  // `manual`: the caller drives `tick()` itself (tests); otherwise it runs now and every TICK_MS.
  if (deps.manual !== true) {
    timer = setInterval(() => { void tick(); }, TICK_MS);
    timer.unref();
    void tick();
  }
  return {
    wake: () => { if (deps.manual !== true) void tick(); },
    tick,
    health: (ownerId) => health.report(ownerId),
    stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
