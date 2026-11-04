/**
 * One-time rewrite of the connections to the MCP servers our own gateway hosts (Gmail, Calendar, Drive, ..., YouTube, Singapore
 * transport) from a full URL to the path alone (BACKEND 10.18.5). A row stored `http://127.0.0.1:8787/mcp/google/gmail` stopped being
 * "ours" the day BETTER_AUTH_URL changed; now the origin is added when the connection is used. `endpoint` and, for a signed-in app,
 * `auth.resource` (a plain field of the sealed record: the tokens stay ciphertext and are not touched) are rewritten whatever origin
 * they were stored with. Rows of third-party catalog apps and custom servers keep their URL. A marker row makes later boots skip it.
 */
import type { Store } from 'juno-agent/contracts';
import { getRow, newRow, putRow } from 'juno-agent/modules/home/mirror';
import { listAll } from 'juno-agent/modules/memory/util';
import { isHostedCatalogId } from 'juno-agent/modules/mcp/catalog';
import { hostedPathOfUrl } from 'juno-agent/modules/tools/net/guardedFetch';

export const MARKER = '__migrations/hosted-endpoint-paths-v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function migrateHostedEndpoints(store: Store): Promise<{ skipped: boolean; rewritten: number }> {
  if ((await getRow(store, 'system', MARKER)) !== null) return { skipped: true, rewritten: 0 };
  let rewritten = 0;
  for (const connection of await listAll(store, 'connections')) {
    if (!isHostedCatalogId(connection.catalogId)) continue;
    const endpoint = typeof connection.endpoint === 'string' ? hostedPathOfUrl(connection.endpoint) : undefined;
    const auth: unknown = Reflect.get(connection, 'auth');
    const resource = isRecord(auth) && typeof auth['resource'] === 'string' ? hostedPathOfUrl(auth['resource']) : undefined;
    if (endpoint === undefined && resource === undefined) continue;
    await store.put('connections', {
      ...connection,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(resource === undefined || !isRecord(auth) ? {} : { auth: { ...auth, resource } }),
    });
    rewritten += 1;
  }
  await putRow(store, newRow('system', MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, rewritten };
}
