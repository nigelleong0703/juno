import type { DurableDb } from './db.js';
import type { LeaseFence } from './lease.js';

export type InvocationStatus = 'pending' | 'running' | 'done' | 'failed';

export interface InvocationRow {
  id: string;
  service: string;
  key: string;
  handler: string;
  input: string | null;
  status: InvocationStatus;
  notBefore: number | null;
  attempt: number;
  result: string | null;
  error: string | null;
  createdAt: number;
}

export interface NewInvocation {
  id: string;
  service: string;
  key: string;
  handler: string;
  input: string | null;
  notBefore: number | null;
  idempotencyKey: string | null;
  now: number;
}

export interface JournalEntry {
  name: string;
  result: string | null;
  error: string | null;
}

export interface WaitRow {
  kind: string;
  value: string | null;
  resolvedAt: number | null;
}

/** A claimed invocation plus the lease tokens a fenced write must carry. */
export interface ClaimedInvocation extends InvocationRow {
  epoch: number;
  leaseExpiresAt: number;
  fence: LeaseFence;
}

const COLUMNS = 'id, service, key, handler, input, status, not_before, attempt, result, error, created_at';
const CLAIM_COLUMNS = `${COLUMNS}, epoch, lease_expires_at`;
/** Database time in epoch milliseconds: the single clock leases, due times and fencing decisions use. */
const DB_NOW = '(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint';
/** Internal sentinel: a finish that lost its fence must roll back (the lane delete) and report false. */
class FinishRejected extends Error {}

/**
 * The channel an idle worker listens on instead of polling for work. A NOTIFY is sent in the same transaction as the change that can
 * make something claimable (a new invocation, a lane freed by a finish or a release), so it is delivered at commit and a woken worker
 * finds the row. Expiries (a delayed start, a dead worker's lease) have no event: the runner sets a timer for the next one
 * (`nextDueInMs`). A notification carries nothing the claim needs; the claim query is the only authority.
 */
export const WORK_CHANNEL = 'durable_work';
const NOTIFY_WORK = `SELECT pg_notify('${WORK_CHANNEL}', '')`;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num =(value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function toInvocation(row: Record<string, unknown>): InvocationRow {
  const status = text(row['status']);
  return {
    id: String(row['id']),
    service: String(row['service']),
    key: String(row['key']),
    handler: String(row['handler']),
    input: text(row['input']),
    status: status === 'running' || status === 'done' || status === 'failed' ? status : 'pending',
    notBefore: num(row['not_before']),
    attempt: Number(row['attempt']),
    result: text(row['result']),
    error: text(row['error']),
    createdAt: Number(row['created_at']),
  };
}

/** Every SQL statement the runner issues; the schema is migrations/0027_durable_runner.sql. */
export class DurableStore {
  constructor(readonly db: DurableDb) {}

  /** Database time, the clock every lease decision uses. */
  async now(): Promise<number> {
    const rows = await this.db.query<{ t: string | number }>(`SELECT ${DB_NOW} AS t`);
    return Number(rows[0]?.['t'] ?? 0);
  }

  /** Insert a pending invocation; a repeated idempotency key returns the first row's id instead. */
  async insert(row: NewInvocation): Promise<{ id: string; created: boolean }> {
    const inserted = await this.db.query(
      `INSERT INTO invocations (id, service, key, handler, input, status, not_before, idempotency_key, attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
      [row.id, row.service, row.key, row.handler, row.input, row.notBefore, row.idempotencyKey, row.now, row.now],
    );
    if (inserted.length > 0) {
      await this.db.query(NOTIFY_WORK);
      return { id: row.id, created: true };
    }
    const existing = await this.db.query('SELECT id FROM invocations WHERE idempotency_key = ?', [row.idempotencyKey]);
    const id = existing[0]?.['id'];
    if (typeof id !== 'string') throw new Error('invocation insert conflicted without an idempotency match');
    return { id, created: false };
  }

  async get(id: string): Promise<InvocationRow | undefined> {
    const rows = await this.db.query(`SELECT ${COLUMNS} FROM invocations WHERE id = ?`, [id]);
    return rows[0] === undefined ? undefined : toInvocation(rows[0]);
  }

  /**
   * One-time handover of rows written before worker leases existed. The caller must hold the same whole-process
   * advisory lock an older agentd holds; only then is it certain that no live executor owns those rows.
   */
  async reclaimLegacy(): Promise<number> {
    const rows = await this.db.query(
      `UPDATE invocations SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ${DB_NOW}
       WHERE status = 'running' AND lease_expires_at IS NULL RETURNING id`,
    );
    return rows.length;
  }

  // ---- coordinator capability marker (mixed-version gate) ----

  /** Publish (or refresh) the coordinator's worker-lease capability and heartbeat. */
  async activateCoordination(name = 'worker-leases'): Promise<number> {
    const rows = await this.db.query<{ generation: string | number }>(
      `INSERT INTO durable_coordination (name, state, generation, heartbeat_at) VALUES (?, 'active', 1, ${DB_NOW})
       ON CONFLICT (name) DO UPDATE SET state = 'active', generation = durable_coordination.generation + 1, heartbeat_at = ${DB_NOW}
       RETURNING generation`,
      [name],
    );
    return Number(rows[0]?.['generation'] ?? 0);
  }

  async heartbeatCoordination(name = 'worker-leases'): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE durable_coordination SET heartbeat_at = ${DB_NOW} WHERE name = ? AND state = 'active' RETURNING name`,
      [name],
    );
    return rows.length > 0;
  }

  /** Graceful coordinator stop: workers stop claiming instead of waiting for the heartbeat to go stale. */
  async drainCoordination(name = 'worker-leases'): Promise<void> {
    await this.db.query(`UPDATE durable_coordination SET state = 'drained', heartbeat_at = ${DB_NOW} WHERE name = ?`, [name]);
  }

  /** Active and heartbeating within `staleMs`, as database time measures it. */
  async coordinationReady(name = 'worker-leases', staleMs = 30_000): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 AS ok FROM durable_coordination
       WHERE name = ? AND state = 'active' AND heartbeat_at > ${DB_NOW} - ?`,
      [name, staleMs],
    );
    return rows.length > 0;
  }

  /**
   * Claim one claimable invocation and its exclusive (service, key) lane in one transaction. Claimable means
   * a due `pending` row, or a `running` row whose database lease has expired (its owner is gone): the takeover
   * happens here, in the same select, so a crashed worker's work is picked up by any live worker at any time,
   * not only at a restart. Healthy leases are never taken; a row with no lease at all (written before worker
   * leases) is never claimable, only `reclaimLegacy` may take it. Returns undefined when nothing is claimable
   * or every key is held by a live owner. The lane upsert is the cross-worker serialization point: a concurrent
   * claim of the same key blocks on the row and then skips it; an expired lane is overwritten by the new owner.
   */
  async claim(owner: string, ttlMs: number): Promise<ClaimedInvocation | undefined> {
    return this.db.transaction(async (tx) => {
      const now = Number((await tx.query<{ t: string | number }>(`SELECT ${DB_NOW} AS t`))[0]?.['t'] ?? 0);
      const due = await tx.query<{ id: string; service: string; key: string }>(
        `SELECT i.id, i.service, i.key FROM invocations i
         WHERE ((i.status = 'pending' AND COALESCE(i.not_before, i.created_at) <= ?)
             OR (i.status = 'running' AND i.lease_expires_at IS NOT NULL AND i.lease_expires_at <= ?))
           AND NOT EXISTS (SELECT 1 FROM invocation_lanes l WHERE l.service = i.service AND l.key = i.key AND l.expires_at > ?)
         ORDER BY CASE WHEN i.status = 'running' THEN i.lease_expires_at ELSE COALESCE(i.not_before, i.created_at) END, i.id
         LIMIT 1
         FOR UPDATE OF i SKIP LOCKED`,
        [now, now, now],
      );
      const candidate = due[0];
      if (candidate === undefined) return undefined;
      const lane = await tx.query<{ epoch: string | number }>(
        `INSERT INTO invocation_lanes (service, key, owner, epoch, expires_at)
         VALUES (?, ?, ?, nextval('durable_epoch_seq'), ?)
         ON CONFLICT (service, key) DO UPDATE SET owner = excluded.owner, epoch = excluded.epoch, expires_at = excluded.expires_at
         WHERE invocation_lanes.expires_at IS NULL OR invocation_lanes.expires_at <= ?
         RETURNING epoch`,
        [candidate.service, candidate.key, owner, now + ttlMs, now],
      );
      const laneEpoch = lane[0]?.['epoch'];
      if (laneEpoch === undefined) return undefined;
      const claimed = await tx.query(
        `UPDATE invocations SET status = 'running', attempt = attempt + 1, epoch = nextval('durable_epoch_seq'),
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND (status = 'pending' OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
         RETURNING ${CLAIM_COLUMNS}`,
        [owner, now + ttlMs, now, candidate.id, now],
      );
      const row = claimed[0];
      if (row === undefined) return undefined;
      return {
        ...toInvocation(row),
        epoch: Number(row['epoch']),
        leaseExpiresAt: Number(row['lease_expires_at']),
        fence: { id: candidate.id, service: candidate.service, key: candidate.key, owner, epoch: Number(row['epoch']), laneEpoch: Number(laneEpoch) },
      };
    });
  }

  /**
   * Extend the leases this worker still owns. Returns the ids that could not be renewed (expired, released or taken
   * over): the caller must stop those executions before they write again.
   *
   * Each lease renews in its own transaction, invocation row first and lane second (the lock order every statement
   * on the pair uses, see `assertLeaseRow`). The lane is the cross-invocation guarantee, so if its update finds
   * nothing the error rolls the invocation's extension back too — there is never a partial renewal where the
   * invocation lives on without its lane.
   */
  async renew(fences: readonly LeaseFence[], ttlMs: number): Promise<string[]> {
    if (fences.length === 0) return [];
    const lost: string[] = [];
    for (const fence of fences) {
      try {
        const renewed = await this.db.transaction(async (tx) => {
          const now = Number((await tx.query<{ t: string | number }>(`SELECT ${DB_NOW} AS t`))[0]?.['t'] ?? 0);
          const rows = await tx.query(
            `UPDATE invocations SET lease_expires_at = ?, updated_at = ?
             WHERE id = ? AND status = 'running' AND lease_owner = ? AND epoch = ? AND lease_expires_at > ?
             RETURNING id`,
            [now + ttlMs, now, fence.id, fence.owner, fence.epoch, now],
          );
          if (rows.length === 0) return false;
          const lane = await tx.query(
            `UPDATE invocation_lanes SET expires_at = ?
             WHERE service = ? AND key = ? AND owner = ? AND epoch = ? AND expires_at > ?
             RETURNING epoch`,
            [now + ttlMs, fence.service, fence.key, fence.owner, fence.laneEpoch, now],
          );
          // Rolls back the invocation's extension too: a half-renewed lease must not survive.
          if (lane.length === 0) throw new Error('lease renewal lost the lane fence');
          return true;
        });
        if (!renewed) lost.push(fence.id);
      } catch {
        lost.push(fence.id);
      }
    }
    return lost;
  }

  /** Give a claimed invocation back (graceful stop): it becomes pending again and the lane is freed at once. */
  async release(fence: LeaseFence): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE invocations SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ${DB_NOW}
         WHERE id = ? AND status = 'running' AND lease_owner = ? AND epoch = ?`,
        [fence.id, fence.owner, fence.epoch],
      );
      await tx.query(
        'DELETE FROM invocation_lanes WHERE service = ? AND key = ? AND owner = ? AND epoch = ?',
        [fence.service, fence.key, fence.owner, fence.laneEpoch],
      );
      await tx.query(NOTIFY_WORK);
    });
  }

  /**
   * Milliseconds (database time) until the next thing a worker could claim becomes claimable by the clock alone: a delayed
   * invocation's start, the end of the lane lease that holds a pending one back, or the expiry of a running lease (its owner may
   * be dead). Null when there is nothing to wait for. A pending row behind a LIVE lane counts from that lane's expiry, not from its
   * own due time, so a busy key does not make an idle worker spin; the finish that frees the lane sends a notification.
   */
  async nextDueInMs(): Promise<number | null> {
    const rows = await this.db.query<{ in_ms: string | number | null }>(
      `SELECT MIN(d.due) - ${DB_NOW} AS in_ms FROM (
         SELECT GREATEST(COALESCE(i.not_before, i.created_at), COALESCE(l.expires_at, 0)) AS due
           FROM invocations i LEFT JOIN invocation_lanes l ON l.service = i.service AND l.key = i.key
          WHERE i.status = 'pending'
         UNION ALL
         SELECT lease_expires_at FROM invocations WHERE status = 'running' AND lease_expires_at IS NOT NULL
       ) d`,
    );
    return num(rows[0]?.['in_ms']);
  }

  /** Persist the attempt number a retry is about to run; false when the lease is gone. */
  async markAttempt(id: string, attempt: number, fence: LeaseFence): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE invocations SET attempt = ?, updated_at = ${DB_NOW}
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND epoch = ? AND lease_expires_at > ${DB_NOW}
         AND EXISTS (SELECT 1 FROM invocation_lanes l WHERE l.service = invocations.service AND l.key = invocations.key
                     AND l.owner = ? AND l.epoch = ? AND l.expires_at > ${DB_NOW})
       RETURNING id`,
      [attempt, id, fence.owner, fence.epoch, fence.owner, fence.laneEpoch],
    );
    return rows.length > 0;
  }

  /** True while a Run-like invocation for this target is waiting or executing. */
  async live(service: string, key: string, handler: string): Promise<boolean> {
    const rows = await this.db.query("SELECT id FROM invocations WHERE service = ? AND key = ? AND handler = ? AND status IN ('pending', 'running') LIMIT 1", [service, key, handler]);
    return rows.length > 0;
  }

  async journal(invocationId: string): Promise<Map<number, JournalEntry>> {
    const rows = await this.db.query('SELECT seq, name, result, error FROM journal WHERE invocation_id = ?', [invocationId]);
    return new Map(rows.map((row) => [Number(row['seq']), { name: String(row['name']), result: text(row['result']), error: text(row['error']) }]));
  }

  /**
   * Append one journal step, only while this worker still owns a live lease. Returns false (and writes nothing) for a
   * stale epoch or an expired lease, which is what stops a worker that lost ownership from continuing another's run.
   */
  async putJournal(invocationId: string, seq: number, name: string, result: string | null, error: string | null, fence: LeaseFence): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO journal (invocation_id, seq, name, result, error)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM invocations i JOIN invocation_lanes l ON l.service = i.service AND l.key = i.key
         WHERE i.id = ? AND i.status = 'running' AND i.lease_owner = ? AND i.epoch = ? AND i.lease_expires_at > ${DB_NOW}
           AND l.owner = ? AND l.epoch = ? AND l.expires_at > ${DB_NOW}
       )
       ON CONFLICT (invocation_id, seq) DO NOTHING
       RETURNING invocation_id`,
      [invocationId, seq, name, result, error, invocationId, fence.owner, fence.epoch, fence.owner, fence.laneEpoch],
    );
    return rows.length > 0;
  }

  async state(service: string, key: string): Promise<Record<string, unknown>> {
    const rows = await this.db.query('SELECT state FROM objects WHERE service = ? AND key = ?', [service, key]);
    const raw = text(rows[0]?.['state']);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
  }

  /**
   * End an invocation: outcome, object state (when it changed) and the cleanup of its journal/awakeables in one
   * transaction. The update is fenced, so a worker that lost its lease writes nothing at all — no result, no state
   * overwrite, no journal deletion. Returns false when the fence no longer matches.
   */
  async finish(outcome: { status: 'done' | 'failed'; result: string | null; error: string | null }, state: { service: string; key: string; json: string } | undefined, fence: LeaseFence): Promise<boolean> {
    const id = fence.id;
    try {
      return await this.db.transaction(async (tx) => {
        // Invocation row first, lane second (the shared lock order). A worker that lost either one (another invocation took
        // the key, or the lease expired) may not finish at all: the rollback also undoes the half that did match.
        const owned = await tx.query(
          `UPDATE invocations SET status = ?, result = ?, error = ?, updated_at = ${DB_NOW}, lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'running' AND lease_owner = ? AND epoch = ? AND lease_expires_at > ${DB_NOW}
           RETURNING id`,
          [outcome.status, outcome.result, outcome.error, id, fence.owner, fence.epoch],
        );
        if (owned.length === 0) throw new FinishRejected('invocation fence lost');
        const lane = await tx.query(
          'DELETE FROM invocation_lanes WHERE service = ? AND key = ? AND owner = ? AND epoch = ? RETURNING epoch',
          [fence.service, fence.key, fence.owner, fence.laneEpoch],
        );
        if (lane.length === 0) throw new FinishRejected('lane fence lost');
        if (state !== undefined) {
          await tx.query('INSERT INTO objects (service, key, state) VALUES (?, ?, ?) ON CONFLICT (service, key) DO UPDATE SET state = excluded.state', [state.service, state.key, state.json]);
        }
        await tx.query('DELETE FROM journal WHERE invocation_id = ?', [id]);
        await tx.query("DELETE FROM waits WHERE invocation_id = ? AND kind = 'awakeable'", [id]);
        // The lane is free: a pending invocation of the same key may be claimable now.
        await tx.query(NOTIFY_WORK);
        return true;
      });
    } catch (error) {
      if (error instanceof FinishRejected) return false;
      throw error;
    }
  }

  async wait(id: string): Promise<WaitRow | undefined> {
    const rows = await this.db.query('SELECT kind, value, resolved_at FROM waits WHERE id = ?', [id]);
    const row = rows[0];
    return row === undefined ? undefined : { kind: String(row['kind']), value: text(row['value']), resolvedAt: num(row['resolved_at']) };
  }

  /** Make sure the wait row exists (an early resolve may have created it already). */
  async openWait(id: string, invocationId: string | null, kind: string, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO waits (id, invocation_id, kind, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET invocation_id = COALESCE(waits.invocation_id, excluded.invocation_id)`,
      [id, invocationId, kind, now],
    );
  }

  /** First resolver wins: true only for the call that changed the row. */
  async resolveWait(id: string, kind: string, value: string | null, now: number): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO waits (id, kind, value, resolved_at, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET value = excluded.value, resolved_at = excluded.resolved_at WHERE waits.resolved_at IS NULL
       RETURNING id`,
      [id, kind, value, now, now],
    );
    return rows.length > 0;
  }

  /**
   * Delete everything stored under these keys: invocations (pending, running and finished, with their journal and waits) and
   * the key's object state. `exact` are whole keys, `prefixes` match every key that starts with them. Returns how many
   * invocations went. A running handler whose rows vanish simply fails to write its outcome.
   */
  async forget(keys: { exact: readonly string[]; prefixes: readonly string[] }): Promise<number> {
    const terms: Array<{ sql: string; param: string }> = [
      ...keys.exact.map((key) => ({ sql: 'key = ?', param: key })),
      ...keys.prefixes.map((prefix) => ({ sql: "key LIKE ? ESCAPE '\\'", param: prefix.replace(/[\\%_]/g, '\\$&') + '%' })),
    ];
    let removed = 0;
    for (let start = 0; start < terms.length; start += 100) {
      const chunk = terms.slice(start, start + 100);
      const where = chunk.map((term) => term.sql).join(' OR ');
      const params = chunk.map((term) => term.param);
      const found = Number((await this.db.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM invocations WHERE ${where}`, params))[0]?.n ?? 0);
      await this.db.transaction(async (tx) => {
        await tx.query(`DELETE FROM journal WHERE invocation_id IN (SELECT id FROM invocations WHERE ${where})`, params);
        await tx.query(`DELETE FROM waits WHERE invocation_id IN (SELECT id FROM invocations WHERE ${where})`, params);
        await tx.query(`DELETE FROM invocations WHERE ${where}`, params);
        await tx.query(`DELETE FROM objects WHERE ${where}`, params);
        await tx.query(`DELETE FROM invocation_lanes WHERE ${where}`, params);
      });
      removed += found;
    }
    return removed;
  }

  /** Drop finished invocations, resolved waits and orphaned journal rows older than the retention window. */
  async prune(cutoff: number): Promise<void> {
    await this.db.query("DELETE FROM invocations WHERE status IN ('done', 'failed') AND updated_at < ?", [cutoff]);
    await this.db.query("DELETE FROM journal WHERE invocation_id NOT IN (SELECT id FROM invocations WHERE status IN ('pending', 'running'))");
    await this.db.query('DELETE FROM waits WHERE resolved_at IS NOT NULL AND resolved_at < ?', [cutoff]);
    await this.db.query("DELETE FROM waits WHERE resolved_at IS NULL AND created_at < ? AND (invocation_id IS NULL OR invocation_id NOT IN (SELECT id FROM invocations WHERE status IN ('pending', 'running')))", [cutoff]);
  }
}
