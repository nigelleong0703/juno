/** The removed Singapore connectors leave no rows behind (connections, per-agent toggles, catalog), other apps are untouched, and it runs once. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { migrateRemovedConnectors, migrateRemovedUnconnectable } from '../removed-connectors-migrate.js';

describe('migrateRemovedConnectors', () => {
  it('deletes sg-transport and sg-weather rows everywhere and keeps the rest', async () => {
    const store = createMemoryStore();
    const connection = (id: string, catalogId?: string) => store.put('connections', { id, kind: 'mcp', name: id, ownerId: 'o1', enabled: true, status: 'connected', transport: 'http', endpoint: '/mcp/x', ...(catalogId === undefined ? {} : { catalogId }) } as never);
    await connection('con-sg', 'sg-transport');
    await connection('con-weather', 'sg-weather');
    await connection('con-gmail', 'gmail');
    await connection('con-custom');
    const toggle = (agentId: string, appId: string) => store.put('agentApps', { id: agentId + ':' + appId, ownerId: 'o1', agentId, appId, enabled: false, actionsPolicy: 'off', updatedAt: '2026-11-02T00:00:00Z' } as never);
    await toggle('a1', 'sg-transport');
    await toggle('a1', 'gmail');
    await store.put('appCatalog', { id: 'sg-transport@1', ownerId: 'system', appId: 'sg-transport', version: 1 } as never);
    await store.put('appCatalog', { id: 'gmail@1', ownerId: 'system', appId: 'gmail', version: 1 } as never);

    expect(await migrateRemovedConnectors(store)).toEqual({ skipped: false, connections: 2, toggles: 1, catalog: 1 });
    expect(await store.get('connections', 'con-sg')).toBeNull();
    expect(await store.get('connections', 'con-weather')).toBeNull();
    expect(await store.get('connections', 'con-gmail')).not.toBeNull();
    expect(await store.get('connections', 'con-custom')).not.toBeNull();
    expect(await store.get('agentApps', 'a1:sg-transport')).toBeNull();
    expect(await store.get('agentApps', 'a1:gmail')).not.toBeNull();
    expect(await store.get('appCatalog', 'sg-transport@1')).toBeNull();
    expect(await store.get('appCatalog', 'gmail@1')).not.toBeNull();

    expect(await migrateRemovedConnectors(store)).toEqual({ skipped: true, connections: 0, toggles: 0, catalog: 0 });
  });

  it('deletes the connectors an ordinary person cannot connect, keeps Asana and the rest, and runs once', async () => {
    const store = createMemoryStore();
    const connection = (id: string, catalogId: string) => store.put('connections', { id, kind: 'mcp', name: id, ownerId: 'o1', enabled: true, status: 'connected', transport: 'http', endpoint: '/mcp/x', catalogId } as never);
    for (const id of ['hevy', 'strava', 'salesforce', 'spotify', 'shopify-admin', 'dropbox', 'asana']) await connection('con-' + id, id);
    await store.put('agentApps', { id: 'a1:hevy', ownerId: 'o1', agentId: 'a1', appId: 'hevy', enabled: true, actionsPolicy: 'allow', updatedAt: '2026-11-02T00:00:00Z' } as never);
    await store.put('appCatalog', { id: 'dropbox@1', ownerId: 'system', appId: 'dropbox', version: 1 } as never);
    await store.put('appCatalog', { id: 'asana@1', ownerId: 'system', appId: 'asana', version: 1 } as never);

    expect(await migrateRemovedUnconnectable(store)).toEqual({ skipped: false, connections: 6, toggles: 1, catalog: 1 });
    expect(await store.get('connections', 'con-strava')).toBeNull();
    expect(await store.get('connections', 'con-asana')).not.toBeNull();
    expect(await store.get('appCatalog', 'asana@1')).not.toBeNull();
    expect((await migrateRemovedUnconnectable(store)).skipped).toBe(true);
  });
});
