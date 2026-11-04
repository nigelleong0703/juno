/**
 * One-time clean-up of the connectors that need no sign-in (YouTube search, Google Maps:`PLATFORM_KEY_SERVERS`).
 * When YouTube was split in two (2026-10-19) the public `youtube` app stopped asking for a Google sign-in, but a connection made before
 * the split still carries the OAuth record from then. The runtime asks that record for a Bearer token on every request, so once its
 * refresh token died (Google's `invalid_grant`) the public app was `error` / "reconnect" although it needs no account at all. The record
 * is dropped and the row goes back to connected; the owner's personal YouTube is the separate `youtube-account` app.
 * A marker row makes later boots skip it.
 */
import type { Store } from 'juno-agent/contracts';
import { getRow, newRow, putRow } from 'juno-agent/modules/home/mirror';
import { listAll } from 'juno-agent/modules/memory/util';
import { PLATFORM_KEY_SERVERS } from 'juno-agent/modules/mcp/platform-keys';

export const MARKER = '__migrations/keyless-no-sign-in-v1';

export async function migrateKeylessConnections(store: Store): Promise<{ skipped: boolean; cleaned: number }> {
  if ((await getRow(store, 'system', MARKER)) !== null) return { skipped: true, cleaned: 0 };
  const keyless = new Set(PLATFORM_KEY_SERVERS.map((server) => server.catalogId));
  let cleaned = 0;
  for (const connection of await listAll(store, 'connections')) {
    if (connection.catalogId === undefined || !keyless.has(connection.catalogId) || Reflect.get(connection, 'auth') == null) continue;
    const { auth: _auth, scopes: _scopes, needsScope: _needsScope, ...rest } = connection as typeof connection & { auth?: unknown; scopes?: unknown; needsScope?: unknown };
    await store.put('connections', { ...rest, ...(connection.enabled === false ? {} : { status: 'connected' as const }) });
    cleaned += 1;
  }
  await putRow(store, newRow('system', MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, cleaned };
}
