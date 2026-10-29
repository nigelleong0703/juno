/**
 * H-75: real spend per agent-to-agent chain (hop.chainId), so the peer-cost guard stops a costly loop
 * instead of reading a hardcoded 0. One system audit row per chain (`chain-cost-<chainId>`) holds the
 * running total and the run ids already counted, so a replayed finish never counts a run twice.
 */
import type { Store, WakeEvent } from '../../../contracts/index.js';
import type { RunInput } from './run-types.js';
import { auditInitiatorFor } from '../logic/run-origin.js';

const MAX_COUNTED_RUNS = 200;

interface ChainCost { chainId: string; costUsd: number; runIds: string[] }

function rowId(chainId: string): string {
  return 'chain-cost-' + chainId;
}

function parse(target: string | undefined, chainId: string): ChainCost {
  if (target !== undefined) {
    try {
      const value: unknown = JSON.parse(target);
      if (typeof value === 'object' && value !== null) {
        const cost = Reflect.get(value, 'costUsd');
        const runs = Reflect.get(value, 'runIds');
        if (typeof cost === 'number' && Number.isFinite(cost) && Array.isArray(runs)) {
          return { chainId, costUsd: cost, runIds: runs.filter((r): r is string => typeof r === 'string') };
        }
      }
    } catch {
      // A malformed row counts as zero spend rather than blocking every wake in the chain.
    }
  }
  return { chainId, costUsd: 0, runIds: [] };
}

/** Total USD the chain this wake belongs to has spent so far (0 outside a chain). */
export async function readChainCost(store: Store, event: Pick<WakeEvent, 'hop'>): Promise<number> {
  const chainId = event.hop?.chainId;
  if (chainId === undefined) return 0;
  const row = await store.get('audit', rowId(chainId));
  return parse(row?.target, chainId).costUsd;
}

/** The hop a run was woken at, kept so a platform reply of that run (a Discord post that mentions another agent) continues the same chain. */
export async function recordRunHop(store: Store, input: RunInput, runId: string): Promise<void> {
  const hop = input.wakeEvents.find((w) => w.hop !== undefined)?.hop;
  if (hop === undefined) return;
  await store.put('audit', {
    ...auditInitiatorFor(null),
    id: 'run-hop-' + runId, at: new Date().toISOString(), actor: 'system', agentId: input.agentId,
    action: 'peer.run.hop', decision: 'auto_allowed', reason: 'hop of the wake that started this run', target: JSON.stringify(hop),
  }, { agentId: input.agentId, kind: 'peer.run.hop' });
}

/** The hop recorded for this run; undefined for a run a user started (no chain yet). */
export async function readRunHop(store: Store, runId: string): Promise<{ chainId: string; depth: number } | undefined> {
  const row = await store.get('audit', 'run-hop-' + runId);
  try {
    const value: unknown = row?.target === undefined ? undefined : JSON.parse(row.target);
    const chainId = typeof value === 'object' && value !== null ? Reflect.get(value, 'chainId') : undefined;
    const depth = typeof value === 'object' && value !== null ? Reflect.get(value, 'depth') : undefined;
    return typeof chainId === 'string' && typeof depth === 'number' ? { chainId, depth } : undefined;
  } catch {
    return undefined;
  }
}

/** Add this finished run's cost to its chain (runs started by a chained wake only); idempotent per run. */
export async function recordChainCost(store: Store, input: RunInput, runId: string): Promise<void> {
  const chainId = input.wakeEvents.find((w) => w.hop !== undefined)?.hop?.chainId;
  if (chainId === undefined) return;
  const run = await store.get('runs', runId);
  const spent = run?.usage.costUsd ?? 0;
  if (!Number.isFinite(spent) || spent <= 0) return;
  const existing = await store.get('audit', rowId(chainId));
  const current = parse(existing?.target, chainId);
  if (current.runIds.includes(runId)) return;
  const next: ChainCost = { chainId, costUsd: current.costUsd + spent, runIds: [...current.runIds, runId].slice(-MAX_COUNTED_RUNS) };
  await store.put('audit', {
    ...auditInitiatorFor(null),
    id: rowId(chainId), at: new Date().toISOString(), actor: 'system', agentId: input.agentId,
    action: 'peer.chain.cost', decision: 'auto_allowed', reason: 'agent-to-agent chain spend', target: JSON.stringify(next),
  }, { agentId: input.agentId, kind: 'peer.chain.cost' });
}
