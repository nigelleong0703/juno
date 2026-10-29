import { backendConfigSchema } from 'juno-agent';
import { z } from 'zod';

/**
 * agentd-local wiring the shared backend schema does not own: the service bearer packages/api uses
 * to reach this private process. Kept separate so contracts stays generic.
 */
const internalEnvSchema = z.object({
  INTERNAL_AGENTD_TOKEN: z.string().default(''),
  /** memoryd (BACKEND §2.4): when set, the agent runtime reads and writes memory through it; empty keeps memory in this process. */
  MEMORYD_URL: z.string().default(''),
  /** The bearer memoryd and agentd share (required when MEMORYD_URL is set). */
  MEMORYD_TOKEN: z.string().default(''),
  /**
   * all         one process: coordinator singletons plus durable execution (the historical behaviour)
   * coordinator platform singletons and the private HTTP API only; it stores work for workers and executes none
   * worker      an execution-only process: no global instance lock, no platform singletons, no HTTP API
   */
  AGENTD_ROLE: z.enum(['all', 'coordinator', 'worker']).default('all'),
  /**
   * How many durable invocations one process uses at once (default 8). Runs that only wait (an approval, a sleep, a child's
   * result) do not count, so this shares a burst of work between workers without ever stalling on waiting runs.
   */
  AGENTD_WORKER_CONCURRENCY: z.coerce.number().int().min(1).optional(),
  /** How long an execution lease stays valid without renewal; a crashed worker's work is taken over after this (default 15 s, renewed every third). */
  AGENTD_LEASE_TTL_MS: z.coerce.number().int().min(3_000).default(15_000),
  /** A stable name for this process in the lease rows (default host:pid:random). Two live processes must never share one. */
  AGENTD_WORKER_ID: z.string().default(''),
  /**
   * Postgres connections one `all` / `coordinator` process may hold in its pool (default 12) and one `worker` process (default 8). The
   * budget formula and the defaults are BACKEND 2.2c; the coordinator refuses to start when the whole deployment cannot fit.
   */
  AGENTD_DB_POOL_MAX: z.coerce.number().int().min(2).max(100).optional(),
  AGENTD_WORKER_DB_POOL_MAX: z.coerce.number().int().min(2).max(100).optional(),
  /** How many workers this deployment runs against the database; the coordinator counts their connections in its budget check (default 0). */
  AGENTD_EXPECTED_WORKERS: z.coerce.number().int().min(0).max(200).default(0),
  /** The pools of the other services on the same database, so the budget sees them (they read the same variables). */
  API_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
  MEMORYD_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
});

let cachedConfig: ReturnType<typeof loadConfig> | null = null;

function loadConfig() {
  return {
    ...backendConfigSchema.parse(process.env),
    ...internalEnvSchema.parse(process.env),
  };
}

export function getConfig() {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

// Convenience exports for services
export const OWNER_ID = getConfig().OWNER_ID;
export const AGENTD_PORT = getConfig().AGENTD_PORT;
export const API_TOKEN = getConfig().API_TOKEN;
