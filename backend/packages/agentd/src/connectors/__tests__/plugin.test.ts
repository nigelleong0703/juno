import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer } from '@agent-desktop/contracts';
import { BUILTIN_CATALOG_ENTRIES, createConnectorCatalog, type CatalogEntry } from 'juno-agent/modules/mcp/catalog';
import { createStoredCatalog } from 'juno-agent/modules/apps/catalog';
import { seedRows } from '../../apps/seed.js';
import { createTestApp, TEST_INTERNAL_TOKEN } from '../../__tests__/test-app.js';
import { createPluginHost, type PluginRow } from '../../plugins/host.js';
import type { AgentdPlugin, Services } from '../../plugins/services.js';
import { connectorsBuiltinPlugin } from '../plugin.js';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const acme: CatalogEntry = { id: 'acme-crm', name: 'Acme CRM', icon: 'crm', description: 'Customer records.', category: 'productivity', url: 'https://mcp.acme.test/mcp' };
const acmePlugin: AgentdPlugin = { name: 'acme', apply(ctx) { ctx.connectors.register(acme); } };

async function loaded(plugins: AgentdPlugin[], rows: Record<string, PluginRow> = {}) {
  const host = createPluginHost<Services>({ log: quiet, rows });
  for (const plugin of plugins) host.use(plugin);
  await host.load();
  return host;
}

describe('connectors-builtin plugin', () => {
  it('registers the built-in entries through ctx.connectors, and another plugin\'s connectors join the same catalog', async () => {
    const host = await loaded([connectorsBuiltinPlugin, acmePlugin]);
    expect(host.status().map((status) => status.state)).toEqual(['active', 'active']);
    const catalog = createConnectorCatalog(host.connectors());
    expect(catalog.list().map((entry) => entry.id)).toEqual([...BUILTIN_CATALOG_ENTRIES.map((entry) => entry.id), 'acme-crm']);
    expect(catalog.get('gmail')?.name).toBe('Gmail');
    expect(catalog.get('acme-crm')).toEqual(acme);
  });

  it('turning it off via JUNO_PLUGINS removes every built-in and leaves other plugins\' connectors', async () => {
    const host = await loaded([connectorsBuiltinPlugin, acmePlugin], { 'connectors-builtin': { enabled: false } });
    const catalog = createConnectorCatalog(host.connectors());
    expect(catalog.list()).toEqual([acme]);
    expect(catalog.get('gmail')).toBeUndefined();
  });

  it('a plugin that reuses a built-in id fails alone and the catalog keeps one entry per id', async () => {
    const clash: AgentdPlugin = { name: 'clash', apply(ctx) { ctx.connectors.register({ ...acme, id: 'gmail' }); } };
    const host = await loaded([connectorsBuiltinPlugin, clash]);
    expect(host.status()).toEqual([{ name: 'connectors-builtin', state: 'active' }, expect.objectContaining({ name: 'clash', state: 'failed' })]);
    expect(createConnectorCatalog(host.connectors()).list()).toHaveLength(BUILTIN_CATALOG_ENTRIES.length);
  });
});

describe('GET /internal/connector-catalog', () => {
  const enqueuer: Enqueuer = { enqueue: async () => ({ accepted: true }), stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined };

  it('serves the catalog the plugins built to the service bearer alone, and refuses anyone else', async () => {
    const mem = createMemoryStore();
    const host = await loaded([connectorsBuiltinPlugin, acmePlugin]);
    const appCatalog = await createStoredCatalog({ store: mem, seed: seedRows(host.connectors(), []) });
    const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer, appCatalog });
    const ok = await app.request('/internal/connector-catalog', { headers: { authorization: `Bearer ${TEST_INTERNAL_TOKEN}` } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { items: CatalogEntry[] };
    expect(body.items.map((entry) => entry.id)).toContain('acme-crm');
    expect(body.items).toHaveLength(BUILTIN_CATALOG_ENTRIES.length + 1);
    expect((await app.request('/internal/connector-catalog')).status).toBe(401);
    expect((await app.request('/internal/connector-catalog', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });
});
