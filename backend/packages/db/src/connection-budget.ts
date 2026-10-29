/**
 * How many Postgres connections a deployment opens, and a check at start that they fit (BACKEND 2.2c).
 *
 * Every agentd process owns one pool (`poolMax`) plus connections the driver keeps outside it: the durable runner's LISTEN
 * (every process), the event stream's LISTEN (the coordinator serves SSE) and the instance lock (the coordinator). The public
 * API (`pg` pool) and memoryd (a store pool) connect to the same database. Postgres refuses connections past
 * `max_connections - superuser_reserved_connections`, so the sum must fit, with room left for migrations and an operator's psql.
 *
 *   total = (coordinator pool + 3) + workers x (worker pool + 1) + API pool + memoryd pool + headroom
 *   must be <= max_connections - superuser_reserved_connections
 */
import type { DurableDb } from '@agent-desktop/durable';

/** Connections a process holds beyond its pool: the work LISTEN, plus (coordinator) the events LISTEN and the instance lock. */
export const COORDINATOR_EXTRA_CONNECTIONS = 3;
export const WORKER_EXTRA_CONNECTIONS = 1;
/** Left for `pnpm db:migrate`, psql and monitoring. */
export const HEADROOM_CONNECTIONS = 5;

/** Pool sizes by role when nothing is configured: the coordinator serves HTTP and SSE; a worker's concurrency is bounded (default 8). */
export const DEFAULT_COORDINATOR_POOL = 12;
export const DEFAULT_WORKER_POOL = 8;
export const DEFAULT_API_POOL = 10;
export const DEFAULT_MEMORYD_POOL = 10;

export interface ConnectionPlan {
  /** The coordinator (or the single `all` process); 0 when none runs against this database. */
  coordinatorPool: number;
  workers: number;
  workerPool: number;
  apiPool: number;
  memorydPool: number;
}

export interface ConnectionBudget {
  total: number;
  /** One line per consumer, for the error message and the log. */
  lines: string[];
}

export function plannedConnections(plan: ConnectionPlan): ConnectionBudget {
  const coordinator = plan.coordinatorPool > 0 ? plan.coordinatorPool + COORDINATOR_EXTRA_CONNECTIONS : 0;
  const workers = plan.workers * (plan.workerPool + WORKER_EXTRA_CONNECTIONS);
  const lines = [
    `coordinator: pool ${String(plan.coordinatorPool)} + ${String(COORDINATOR_EXTRA_CONNECTIONS)} (work LISTEN, events LISTEN, instance lock) = ${String(coordinator)}`,
    `workers: ${String(plan.workers)} x (pool ${String(plan.workerPool)} + ${String(WORKER_EXTRA_CONNECTIONS)} work LISTEN) = ${String(workers)}`,
    `api: pool ${String(plan.apiPool)}`,
    `memoryd: pool ${String(plan.memorydPool)}`,
    `headroom for migrations and operators: ${String(HEADROOM_CONNECTIONS)}`,
  ];
  return { total: coordinator + workers + plan.apiPool + plan.memorydPool + HEADROOM_CONNECTIONS, lines };
}

export class ConnectionBudgetError extends Error {}

export interface ServerLimits {
  maxConnections: number;
  reserved: number;
  /** Client connections open right now, from every service and tool. */
  inUse: number;
}

export async function readServerLimits(db: Pick<DurableDb, 'query'>): Promise<ServerLimits> {
  const rows = await db.query<{ max: string; reserved: string; in_use: string | number }>(
    `SELECT current_setting('max_connections') AS max, current_setting('superuser_reserved_connections') AS reserved,
            (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS in_use`,
  );
  const row = rows[0];
  return { maxConnections: Number(row?.max ?? 0), reserved: Number(row?.reserved ?? 0), inUse: Number(row?.in_use ?? 0) };
}

/**
 * Fail at start, with the arithmetic, when the planned deployment cannot fit in the server's `max_connections`, or when this
 * process's own connections do not fit in what is free right now. A pool opens connections on demand, so without this the first
 * burst of work is where "too many clients" would show up.
 */
export async function assertConnectionBudget(
  db: Pick<DurableDb, 'query'>,
  plan: ConnectionPlan,
  mine: { pool: number; extra: number },
): Promise<ServerLimits & ConnectionBudget> {
  const limits = await readServerLimits(db);
  const budget = plannedConnections(plan);
  const usable = limits.maxConnections - limits.reserved;
  if (budget.total > usable) {
    throw new ConnectionBudgetError(
      `The planned Postgres connections (${String(budget.total)}) do not fit in max_connections ${String(limits.maxConnections)} minus ${String(limits.reserved)} reserved = ${String(usable)}:\n  `
      + budget.lines.join('\n  ')
      + '\nLower AGENTD_DB_POOL_MAX / AGENTD_WORKER_DB_POOL_MAX / API_DB_POOL_MAX / MEMORYD_DB_POOL_MAX, run fewer workers (AGENTD_EXPECTED_WORKERS), raise max_connections, or put a pooler (PgBouncer in session mode for the instance lock) in front.',
    );
  }
  const need = mine.pool + mine.extra;
  const free = usable - limits.inUse;
  if (need > free) {
    throw new ConnectionBudgetError(
      `This process needs up to ${String(need)} Postgres connections (pool ${String(mine.pool)} + ${String(mine.extra)}) but only ${String(free)} are free now (${String(limits.inUse)} of ${String(usable)} in use). Stop what holds them or lower this process's pool.`,
    );
  }
  return { ...limits, ...budget };
}
