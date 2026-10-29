/**
 * Route tests drive the SAME app assembly that production serves (`createInternalAgentApp`, the one
 * main.ts starts), with production's own service identity: the internal bearer token plus the
 * `x-owner-id` header packages/api forwards. There is no second, test-only assembly.
 */
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import { createStoredCatalog } from 'juno-agent/modules/apps/catalog';
import { seedRows } from '../apps/seed.js';
import { createInternalAgentApp, type InternalAgentDeps } from '../transport/http/internal-app.js';
import { channelRegistryOf, type ChannelRegistry } from '../channels/registry.js';
import { channelPlugins } from '../plugins/builtin.js';
import { createPluginHost, type PluginRoute, type PluginRow } from '../plugins/host.js';
import type { Services } from '../plugins/services.js';

export const TEST_INTERNAL_TOKEN = 'test-internal-token';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The chat platforms and their HTTP routes, from the same plugin host (so a disabled platform has neither). */
export interface TestPlatforms {
  channels: ChannelRegistry;
  pluginRoutes: readonly PluginRoute[];
}

/**
 * The chat platforms as production gets them: the platform plugins loaded by a real plugin host (`rows` as `JUNO_PLUGINS` would set
 * them). The platform plugins inject `store` and `enqueuer` (the Discord voice holder is built from them, and no test here runs a
 * gateway), so the host is given inert stand-ins.
 */
export async function loadTestPlatforms(rows: Readonly<Record<string, PluginRow>> = {}): Promise<TestPlatforms> {
  const host = createPluginHost<Services>({ log: silentLog, rows });
  host.provide('store', {} as Services['store']);
  host.provide('enqueuer', {} as Services['enqueuer']);
  for (const plugin of channelPlugins) host.use(plugin);
  await host.load();
  return { channels: channelRegistryOf(host), pluginRoutes: host.routes() };
}

export async function loadTestChannels(rows: Readonly<Record<string, PluginRow>> = {}): Promise<ChannelRegistry> {
  return (await loadTestPlatforms(rows)).channels;
}

/** All four platform plugins active; what route and channel tests run against. */
export const testPlatforms = await loadTestPlatforms();
export const testChannels = testPlatforms.channels;

/** The app catalog table of a test that does not bring its own: the chat platforms, no connectors (a test that needs work apps seeds its own). */
const defaultCatalog = await createStoredCatalog({ store: createMemoryStore(), seed: seedRows([], testChannels.all().map((registration) => registration.kind)) });

/**
 * The app production serves, with the platforms of `testPlatforms` unless `channels` names others (from `loadTestPlatforms`, with
 * their own `pluginRoutes`). Passing `channels` alone adds no platform routes: its routes come from the same host or not at all.
 */
export function createTestApp(deps: Omit<InternalAgentDeps, 'internalToken' | 'channels' | 'pluginRoutes'> & { channels?: ChannelRegistry; pluginRoutes?: readonly PluginRoute[] }): Hono {
  const pluginRoutes = deps.pluginRoutes ?? (deps.channels === undefined ? testPlatforms.pluginRoutes : []);
  return createInternalAgentApp({ ...deps, appCatalog: deps.appCatalog ?? defaultCatalog, channels: deps.channels ?? testChannels, pluginRoutes, internalToken: TEST_INTERNAL_TOKEN });
}

/** The headers packages/api sends for an authenticated owner (JSON content type when there is a body). */
export function ownerHeaders(ownerId: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${TEST_INTERNAL_TOKEN}`,
    'x-owner-id': ownerId,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

/** One request as `ownerId`, with an optional JSON body. */
export function requestAs(app: Hono, ownerId: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const hasBody = init.body !== undefined;
  return Promise.resolve(app.request(path, {
    method: init.method ?? 'GET',
    headers: ownerHeaders(ownerId, hasBody),
    ...(hasBody ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
  }));
}

/**
 * Production never writes an ownerless row: every write runs in an owner scope. Test seeds that
 * name no owner are stamped with `ownerId` (rows that name another owner keep it, so isolation tests
 * still seed foreign data); everything else passes straight through to the real store.
 */
export function withDefaultOwner<S extends object>(store: S, ownerId: string): S {
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'put' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
      return (collection: string, doc: Record<string, unknown>, ...rest: unknown[]) =>
        value.call(target, collection, typeof doc.ownerId === 'string' ? doc : { ...doc, ownerId }, ...rest);
    },
  });
}
