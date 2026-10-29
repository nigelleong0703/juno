import type { EngineCatalogEntry } from '@agent-desktop/public-contracts';
import type { RunCancellation } from '../services/cancel.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';
import type { BrainContext } from '../../../contracts/index.js';

/** Capabilities an engine adapter declares (data-only, mirrored in the client catalog). */
export interface EngineCapabilities {
  tools: boolean;
  approvals: boolean;
  steering: boolean;
  deltas: boolean;
}

/**
 * The single named context every full-turn adapter receives. It carries the Run's
 * durable context, services, input, run id, built brain context and cancellation —
 * never a bare Brain.step turn fragment.
 */
export interface EngineTurnContext {
  ctx: RunContext;
  services: RunServices;
  input: RunInput;
  runId: string;
  brainCtx: BrainContext;
  cancellation: RunCancellation;
}

/** How one full turn ended: normally, by a stop, or blocked on outstanding tasks with no progress. */
export type EngineOutcome = 'completed' | 'stopped' | 'blocked';

/** A full-turn execution engine. Exactly one adapter runs per Run; there is no engine fallback (a model fallback happens inside the model step). */
export interface EngineAdapter {
  id: string;
  name: string;
  version: string;
  available: boolean;
  reason?: string;
  capabilities: EngineCapabilities;
  executeTurn: (context: EngineTurnContext) => Promise<EngineOutcome>;
}

export interface EngineRegistry {
  resolve: (id: string) => EngineAdapter;
  catalog: () => EngineCatalogEntry[];
}

function toCatalogEntry(adapter: EngineAdapter): EngineCatalogEntry {
  const entry: EngineCatalogEntry = {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    available: adapter.available,
    capabilities: { ...adapter.capabilities },
  };
  if (adapter.reason !== undefined) return { ...entry, reason: adapter.reason };
  return entry;
}

export function createEngineRegistry(adapters: EngineAdapter[]): EngineRegistry {
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (seen.has(adapter.id)) throw new Error(`duplicate engine adapter: ${adapter.id}`);
    seen.add(adapter.id);
  }
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));

  const resolve = (id: string): EngineAdapter => {
    const adapter = byId.get(id);
    if (!adapter) throw new Error(`unknown engine: ${id}`);
    if (!adapter.available) throw new Error(`engine unavailable: ${id} (${adapter.reason ?? 'not configured'})`);
    return adapter;
  };

  const catalog = (): EngineCatalogEntry[] => adapters.map(toCatalogEntry);

  return { resolve, catalog };
}
