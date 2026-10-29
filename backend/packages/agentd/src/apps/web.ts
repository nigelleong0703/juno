/**
 * Adding a web app (BACKEND 10.18): one the agent reads through its computer (`binding.login` `none` or `sandbox`) is added by writing the owner's installation row, a
 * `connections` row whose `catalogId` is the app's id and which has no endpoint (view.ts `webApp` says why that is enough). The id comes from
 * the app and the owner, so adding twice is one row, and adding again after removing turns that row back on. Removing is the gateway's
 * `DELETE /v1/apps/:id/installations/:installationId` for every connection row (packages/api routes/apps.ts), which needs nothing here.
 */
import { createHash } from 'node:crypto';
import type { AppInstallation } from '@agent-desktop/public-contracts';
import type { AppCatalogRow, Store } from 'juno-agent/contracts';
import { connectionInstallation } from 'juno-agent/modules/apps/agent-apps';
import type { StoredMcpConnection } from 'juno-agent/modules/mcp/connections';

export async function addWebApp(store: Store, ownerId: string, row: Pick<AppCatalogRow, 'appId' | 'interface'>): Promise<AppInstallation> {
  const doc: StoredMcpConnection = {
    id: 'con-' + row.appId + '-' + createHash('sha256').update(ownerId).digest('hex').slice(0, 16),
    kind: 'mcp',
    name: row.interface.displayName,
    status: 'connected',
    enabled: true,
    ownerId,
    catalogId: row.appId,
    connectedAt: new Date().toISOString(),
  };
  const saved = await store.put('connections', doc);
  const installation = connectionInstallation(saved, row.appId, row.interface.displayName);
  if (installation === undefined) throw new Error('the installation row of ' + row.appId + ' was written but does not read as added');
  return installation;
}
