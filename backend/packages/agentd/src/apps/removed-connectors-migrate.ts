/**
 * One-time clean-ups after connectors left the catalog for good. Their connections, the per-agent toggles (`agentApps`, `<agentId>:<appId>`) and the
 * catalog table rows (`appCatalog`, seeded from the built-in list while they existed) are deleted; nothing else may still name them. A marker row
 * per clean-up makes later boots skip it.
 *  - `sg-transport` / `sg-weather` (Singapore transport and weather; owner, 2026-11-02; weather's connection rows had stayed).
 *  - `hevy`, `strava`, `salesforce`, `spotify`, `shopify-admin`, `dropbox`: an ordinary person cannot connect them with one tap (key paste, admin-only,
 *    5-user cap or no registration route; owner rule 2026-11-02, BACKEND connector catalog).
 */
import type { Store } from 'juno-agent/contracts';
import { getRow, newRow, putRow } from 'juno-agent/modules/home/mirror';
import { listAll } from 'juno-agent/modules/memory/util';

export const MARKER = '__migrations/removed-sg-connectors-v1';
export const UNCONNECTABLE_MARKER = '__migrations/removed-unconnectable-connectors-v1';

const SG = new Set(['sg-transport', 'sg-weather']);
const UNCONNECTABLE = new Set(['hevy', 'strava', 'salesforce', 'spotify', 'shopify-admin', 'dropbox']);

interface Removal { skipped: boolean; connections: number; toggles: number; catalog: number }

async function removeRows(store: Store, marker: string, removed: ReadonlySet<string>): Promise<Removal> {
  if ((await getRow(store, 'system', marker)) !== null) return { skipped: true, connections: 0, toggles: 0, catalog: 0 };
  let connections = 0;
  for (const row of await listAll(store, 'connections')) {
    if (row.catalogId === undefined || !removed.has(row.catalogId)) continue;
    await store.delete('connections', row.id);
    connections += 1;
  }
  let toggles = 0;
  for (const row of await listAll(store, 'agentApps')) {
    if (!removed.has(row.appId)) continue;
    await store.delete('agentApps', row.id);
    toggles += 1;
  }
  let catalog = 0;
  for (const row of await listAll(store, 'appCatalog')) {
    if (!removed.has(row.appId)) continue;
    await store.delete('appCatalog', row.id);
    catalog += 1;
  }
  await putRow(store, newRow('system', marker, '', 'platform', new Date().toISOString()));
  return { skipped: false, connections, toggles, catalog };
}

export const migrateRemovedConnectors = (store: Store): Promise<Removal> => removeRows(store, MARKER, SG);
export const migrateRemovedUnconnectable = (store: Store): Promise<Removal> => removeRows(store, UNCONNECTABLE_MARKER, UNCONNECTABLE);
