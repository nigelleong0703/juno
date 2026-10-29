/**
 * The coordinator half of the worker-lease split, and the mixed-version gate around it.
 *
 * An older agentd build holds one whole-process advisory lock, re-queues every `running` invocation on boot, and
 * writes rows with no lease. A new worker must never run beside it: it would read those rows as expired and steal
 * work that is still executing. Only the process that holds the coordinator lock may perform that handover — it
 * knows no other executor is live. After doing so it publishes `worker-leases/active` with a heartbeat; execution
 * workers refuse to start, and stop claiming, unless that marker is present, active and fresh.
 *
 * Rollback boundary: rolling back to an older binary requires draining every worker first. The old coordinator will
 * take the lock and requeue all running work exactly as before, so workers must not be executing when it starts.
 * Stopping this coordinator (or losing its heartbeat) makes workers stop claiming within `COORDINATION_STALE_MS`.
 */
import { createLogger } from '@agent-desktop/log';
import { DurableStore, type DurableDb } from '@agent-desktop/durable';

const log = createLogger({ service: 'agentd' });

export const WORKER_LEASE_CAPABILITY = 'worker-leases';
/** A worker claims no new work when the coordinator's last heartbeat is older than this. */
export const COORDINATION_STALE_MS = 60_000;
const HEARTBEAT_MS = 10_000;

export interface WorkerLeaseCoordination {
  /** Records the drain and stops the heartbeat; call after the coordinator's executors are stopped. */
  stop(): Promise<void>;
}

/**
 * Called only while the whole-process advisory lock is held: reclaim the lease-less rows an older build left behind,
 * then publish the capability marker and keep it fresh.
 */
export async function startWorkerLeaseCoordination(raw: DurableDb): Promise<WorkerLeaseCoordination> {
  const store = new DurableStore(raw);
  const reclaimed = await store.reclaimLegacy();
  if (reclaimed > 0) log.warn({ reclaimed }, 'Reclaimed invocations written before worker leases existed');
  const generation = await store.activateCoordination(WORKER_LEASE_CAPABILITY);
  log.info({ generation }, 'Worker-lease coordination active');
  const timer = setInterval(() => {
    void store.heartbeatCoordination(WORKER_LEASE_CAPABILITY)
      .then((ok) => { if (!ok) log.error('Worker-lease coordination row was changed by another process'); })
      .catch((error: unknown) => log.error({ err: error }, 'Worker-lease heartbeat failed'));
  }, HEARTBEAT_MS);
  timer.unref();
  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await store.drainCoordination(WORKER_LEASE_CAPABILITY).catch((error: unknown) => log.error({ err: error }, 'Could not record the coordinator drain'));
    },
  };
}

/** Fail closed: an execution worker only runs beside a new coordinator that is actively heartbeating. */
export async function requireWorkerLeaseCoordination(raw: DurableDb): Promise<void> {
  const ready = await new DurableStore(raw).coordinationReady(WORKER_LEASE_CAPABILITY, COORDINATION_STALE_MS);
  if (!ready) {
    throw new Error(
      'refusing to start an execution worker: no active worker-lease coordinator. Start the coordinator build first '
      + '(it reclaims pre-lease running rows under the instance lock), or drain the workers before rolling back.',
    );
  }
}
