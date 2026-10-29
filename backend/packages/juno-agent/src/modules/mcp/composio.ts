// Composio as the long-tail path (BACKEND 10.18.3): which catalog rows this deployment can offer through it, and which first-party app makes a
// Composio row redundant. The REST calls themselves are the gateway's (packages/api modules/composio.ts); nothing here talks to Composio.
import type { CatalogEntry } from './catalog.js';

/** The deployment secret that switches the whole path on; unset, no Composio row is offered anywhere (no fallback). */
export const COMPOSIO_KEY_ENV = 'COMPOSIO_API_KEY';

/**
 * The name of the deployment variable holding the id (`ac_...`) of OUR OAuth app registered at Composio for a toolkit. Composio has a managed
 * OAuth app only for some toolkits (docs.composio.dev/toolkits/<slug> says which); for the others a session needs `auth_configs: {<toolkit>: <id>}`
 * (docs.composio.dev/docs/using-custom-auth-configuration).
 */
export const composioAuthConfigEnv = (toolkit: string): string => 'COMPOSIO_AUTH_CONFIG_' + toolkit.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** The toolkits with no Composio-managed OAuth app (checked on their toolkit pages, 2026-10-29): offered only with our own app's auth config id. */
const NEEDS_OWN_APP: ReadonlySet<string> = new Set(['spotify', 'shopify']);

export const composioKeyConfigured = (env: Record<string, string | undefined>): boolean => (env[COMPOSIO_KEY_ENV] ?? '') !== '';

/** The auth config id to hand Composio for a toolkit, when this deployment has one. */
export function composioAuthConfig(toolkit: string, env: Record<string, string | undefined>): string | undefined {
  const id = env[composioAuthConfigEnv(toolkit)];
  return id === undefined || id === '' ? undefined : id;
}

/** True when this deployment can connect the Composio entry: the key is set, and a toolkit with no managed app has ours. */
export function composioOffered(entry: Pick<CatalogEntry, 'toolkit'>, env: Record<string, string | undefined>): boolean {
  if (entry.toolkit === undefined || !composioKeyConfigured(env)) return false;
  return !NEEDS_OWN_APP.has(entry.toolkit) || composioAuthConfig(entry.toolkit, env) !== undefined;
}

/**
 * The catalog as an owner is offered it: a Composio entry only when this deployment can connect it, and not when a first-party entry of the same
 * app exists (same id as its toolkit, e.g. a `notion` toolkit next to the `notion` row), since the first-party path keeps the login with us.
 */
export function withoutCoveredComposio<T extends Pick<CatalogEntry, 'id' | 'source' | 'toolkit'>>(entries: readonly T[], env: Record<string, string | undefined>): T[] {
  const firstParty = new Set(entries.filter((entry) => entry.source !== 'composio').map((entry) => entry.id));
  return entries.filter((entry) => entry.source !== 'composio' || (composioOffered(entry, env) && !firstParty.has(entry.toolkit ?? '')));
}
