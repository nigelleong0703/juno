/**
 * Pending channels (CH7): an identity Juno is creating for the owner (Telegram managed bot, Feishu
 * registerApp, Slack manifest app) that is not usable until the owner confirms on the platform.
 *
 * A request is a short-lived `channels` row of kind `pending` (id `pending:<id>`, the id is the
 * unguessable handle the owner polls and Slack's OAuth `state`). It lives in the same collection so it
 * needs no migration, and no runner scans it (runners filter by their own kind). When the platform
 * finishes, the real channel row is written and the request flips to `connected`; expired requests are
 * answered as `expired` and swept.
 */
import { randomBytes } from 'node:crypto';
import { channelRowId, type ChannelRow, type Store } from '@agent-desktop/contracts';
import { newSecret } from './bind.js';
import type { ChannelRunner } from './runners.js';

export const PENDING_KIND = 'pending';
const SWEEP_MS = 5 * 60_000;
/** How long a finished or expired request stays readable before it is deleted. */
const KEEP_AFTER_MS = 60 * 60_000;

export type PendingData = NonNullable<ChannelRow['pending']>;

export interface NewPending {
  ownerId: string;
  agentId: string;
  ttlMs: number;
  data: Omit<PendingData, 'state' | 'expiresAt'>;
}

export function pendingRowId(id: string): string {
  return channelRowId(PENDING_KIND, id);
}

export async function createPending(store: Store, input: NewPending): Promise<ChannelRow> {
  const now = new Date();
  const id = randomBytes(18).toString('base64url');
  const row: ChannelRow = {
    id: pendingRowId(id),
    ownerId: input.ownerId,
    agentId: input.agentId,
    kind: PENDING_KIND,
    channelId: id,
    secretHashHex: newSecret().hashHex,
    status: 'pending',
    pending: { ...input.data, state: 'pending', expiresAt: new Date(now.getTime() + input.ttlMs).toISOString() },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await store.put('channels', row);
  return row;
}

function isExpired(row: ChannelRow, now = Date.now()): boolean {
  return row.pending !== undefined && row.pending.state === 'pending' && Date.parse(row.pending.expiresAt) <= now;
}

/** The request as it stands now: an overdue `pending` is stored as `expired` the first time anyone looks. */
export async function loadPending(store: Store, id: string): Promise<ChannelRow | null> {
  const row = await store.get('channels', pendingRowId(id));
  if (!row || row.pending === undefined) return null;
  if (!isExpired(row)) return row;
  return store.patch('channels', row.id, { pending: { ...row.pending, state: 'expired' }, status: 'expired', updatedAt: new Date().toISOString() });
}

/** Settles a request that is still pending; a request the owner cancelled (row gone) or that already settled is left alone. */
export async function settlePending(
  store: Store,
  id: string,
  outcome: { state: 'connected'; resultRowId: string } | { state: 'failed'; error: string },
): Promise<void> {
  const row = await loadPending(store, id);
  if (!row?.pending || row.pending.state !== 'pending') return;
  const next: PendingData = { ...row.pending, ...outcome };
  delete next.clientSecret;
  await store.patch('channels', row.id, { pending: next, status: outcome.state, updatedAt: new Date().toISOString() });
}

/** Live (unexpired, unsettled) requests for a platform. */
export async function livePending(store: Store, platform: PendingData['platform']): Promise<ChannelRow[]> {
  const page = await store.list('channels', { where: { kind: PENDING_KIND }, limit: 500 });
  return page.items.filter((row) => row.pending?.platform === platform && row.pending.state === 'pending' && !isExpired(row));
}

export async function sweepPending(store: Store, now = Date.now()): Promise<void> {
  const page = await store.list('channels', { where: { kind: PENDING_KIND }, limit: 500 });
  for (const row of page.items) {
    if (row.pending !== undefined && Date.parse(row.pending.expiresAt) + KEEP_AFTER_MS <= now) await store.delete('channels', row.id);
  }
}

/** Deletes requests that have been over for an hour. Registered as a runner so boot starts it with the others. */
export const pendingSweeper: ChannelRunner = {
  start(ctx) {
    const timer = setInterval(() => { void sweepPending(ctx.store).catch(() => undefined); }, SWEEP_MS);
    timer.unref();
    return () => clearInterval(timer);
  },
};
