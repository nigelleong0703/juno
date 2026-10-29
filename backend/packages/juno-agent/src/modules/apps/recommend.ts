// Recommending catalog apps for a need (BACKEND 10.18.1): the agent's state with each app that provides the capability, ranked.
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { configuredClientFor, platformKeyConfigured, withoutCoveredComposio, type ConnectorCatalog } from '../mcp/index.js';
import { listAll } from '../memory/util.js';
import { agentAppSettings, appProblem, usableApps } from './agent-apps.js';
import { rankForNeed, type Candidate, type CapabilityTag } from './provides.js';

/** The apps of the catalog that provide any of `tags`, best first, as the owner's agent stands with each. */
export async function recommendFor(opts: {
  store: Store;
  catalog: ConnectorCatalog;
  ownerId: string;
  agentId: string;
  tags: readonly CapabilityTag[];
  env: Record<string, string | undefined>;
}): Promise<Candidate[]> {
  const connections = (await listAll(opts.store, 'connections')).filter((connection) => docOwner(connection) === opts.ownerId);
  const settings = await agentAppSettings(opts.store, opts.agentId);
  const usable = usableApps(connections, settings);
  const entries = withoutCoveredComposio(opts.catalog.list(), opts.env);
  const usedIssuers = new Set(entries.flatMap((entry) => (usable.has(entry.id) && entry.configuredClientIssuer !== undefined ? [entry.configuredClientIssuer] : [])));
  return rankForNeed(entries, opts.tags, (entry) => {
    const problem = appProblem(connections, settings, entry.id);
    if (problem === undefined) return 'ready';
    if (problem !== 'not_added') return 'fix';
    if (entry.platformKey === true && !platformKeyConfigured(entry.id, opts.env)) return 'unavailable';
    if (entry.configuredClientIssuer !== undefined && configuredClientFor(entry.configuredClientIssuer, opts.env) === undefined) return 'unavailable';
    return 'add';
  }, usedIssuers);
}
