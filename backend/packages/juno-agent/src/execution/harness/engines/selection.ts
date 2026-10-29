import { PI_ENGINE_ID, type RunEngineSnapshot } from '@agent-desktop/public-contracts';
import type { EngineAdapter, EngineRegistry } from './registry.js';

/** Engine adapter resolved for one Run plus the journaled snapshot. */
export interface ResolvedRunEngine {
  adapter: EngineAdapter;
  snapshot: RunEngineSnapshot;
}

/**
 * Resolve the shared pi engine for a Run. Per-agent engine selection is
 * removed: legacy agent engine/model data is ignored and every Run journals
 * the actual resolved adapter id and version (no agent revision). A registry
 * without an available pi adapter throws — the caller fails the Run honestly,
 * never falls back to another engine.
 */
export function resolveRunEngine(registry: EngineRegistry): ResolvedRunEngine {
  const adapter = registry.resolve(PI_ENGINE_ID);
  return { adapter, snapshot: { id: adapter.id, version: adapter.version } };
}
