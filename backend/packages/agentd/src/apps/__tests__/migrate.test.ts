/**
 * The move to the Apps model (BACKEND 10.18): existing connections and channel rows become installations with the same agents enabled,
 * and what each agent could do before is what its Actions policy says now. Nothing needs to be connected again.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { agentAppSettings, settingFor } from 'juno-agent/modules/apps/agent-apps';
import { createStoredCatalog } from 'juno-agent/modules/apps/catalog';
import { BUILTIN_CATALOG_ENTRIES } from 'juno-agent/modules/mcp/catalog';
import { testChannels } from '../../__tests__/test-app.js';
import { seedRows } from '../seed.js';
import { listApps } from '../view.js';
import { MARKER, migrateApps } from '../migrate.js';

const NOW = '2026-10-26T00:00:00.000Z';
const agent = (id: string, ownerId: string, createdAt: string) => ({ id, name: id, handle: id, createdBy: ownerId, ownerId, pluginIds: [], createdAt, updatedAt: createdAt }) as never;

async function seeded() {
  const store = createMemoryStore();
  // owner o1 has two agents (the older is the main one); owner o2 has one.
  await store.put('agents', agent('main', 'o1', '2026-10-01T00:00:00.000Z'));
  await store.put('agents', agent('second', 'o1', '2026-10-02T00:00:00.000Z'));
  await store.put('agents', agent('theirs', 'o2', '2026-10-01T00:00:00.000Z'));
  const connection = (id: string, ownerId: string, extra: object) => store.put('connections', { id, kind: 'mcp', name: id, status: 'connected', enabled: true, ownerId, ...extra } as never);
  await connection('con-gmail', 'o1', { catalogId: 'gmail', permission: 'read_only' });
  await connection('con-notion', 'o1', { catalogId: 'notion', permission: 'full' });
  await connection('con-mine', 'o1', { endpoint: 'https://mcp.example.com/mcp', permission: 'read_only' });
  await connection('con-old', 'o1', { catalogId: 'linear' });
  await connection('con-theirs', 'o2', { catalogId: 'gmail', permission: 'read_only' });
  // A Slack workspace where only the second agent was ever connected; the main agent answered DMs.
  await store.put('channelInstallations', { id: 'slack:T1', ownerId: 'o1', kind: 'slack', teamId: 'T1', botToken: 'enc', botUserId: 'UBOT', installedBy: 'UOWNER', createdAt: NOW, updatedAt: NOW } as never);
  await store.put('channels', { id: 'slack:T1.second', ownerId: 'o1', agentId: 'second', kind: 'slack', channelId: 'T1.second', secretHashHex: 'x', installationId: 'slack:T1', handle: 'second', handleStatus: 'ok', usergroupId: 'S1', status: 'active', createdAt: NOW, updatedAt: NOW } as never);
  // An agent's own Telegram bot stays what it is.
  await store.put('channels', { id: 'telegram:Bot', ownerId: 'o1', agentId: 'second', kind: 'telegram', channelId: 'Bot', secretHashHex: 'x', status: 'active', createdAt: NOW, updatedAt: NOW } as never);
  return store;
}

describe('migrateApps', () => {
  it('a read-only connection becomes Actions Off for each agent of its owner; full, a custom server and a level-less row keep asking first', async () => {
    const store = await seeded();
    expect(await migrateApps(store)).toEqual({ skipped: false, policies: 5, stripped: 4, dmRows: 1 });
    for (const agentId of ['main', 'second']) {
      const settings = await agentAppSettings(store, agentId);
      expect(settingFor(settings, 'gmail')).toEqual({ enabled: true, actionsPolicy: 'off' });
      expect(settingFor(settings, 'con-mine')).toEqual({ enabled: true, actionsPolicy: 'off' });
      expect(settingFor(settings, 'notion')).toEqual({ enabled: true, actionsPolicy: 'ask' });
      expect(settingFor(settings, 'linear')).toEqual({ enabled: true, actionsPolicy: 'ask' });
    }
    // Only the owner's own agents; another owner's connection is theirs.
    expect(settingFor(await agentAppSettings(store, 'theirs'), 'gmail').actionsPolicy).toBe('off');
    expect((await store.list('agentApps')).items.filter((row) => row.ownerId === 'o1')).toHaveLength(4);
    // The level is gone from the rows.
    for (const row of (await store.list('connections')).items) expect(Reflect.get(row, 'permission')).toBeUndefined();
  });

  it('the Slack workspace keeps the main agent answering DMs: its plain row is made now, the second agent keeps its handle', async () => {
    const store = await seeded();
    await migrateApps(store);
    expect(await store.get('channels', 'slack:T1.main')).toMatchObject({ agentId: 'main', installationId: 'slack:T1', ownerExternalId: 'UOWNER', status: 'active' });
    expect((await store.get('channels', 'slack:T1.main'))?.usergroupId).toBeUndefined();
    expect(await store.get('channels', 'slack:T1.second')).toMatchObject({ handle: 'second', usergroupId: 'S1' });
  });

  it('the Apps view shows the same agents enabled as before: every added app for every agent, the bot for its agent, the workspace for both', async () => {
    const store = await seeded();
    await migrateApps(store);
    const catalog = await createStoredCatalog({ store, seed: seedRows(BUILTIN_CATALOG_ENTRIES, ['slack', 'discord', 'telegram', 'feishu']) });
    const view = await listApps({ store, channels: testChannels, catalog }, 'o1');
    const byId = new Map(view.map((app) => [app.id, app]));
    expect(byId.get('gmail')?.installations).toMatchObject([{ id: 'con-gmail', status: 'connected' }]);
    expect(byId.get('gmail')?.enabledAgents).toEqual([{ agentId: 'main', actionsPolicy: 'off' }, { agentId: 'second', actionsPolicy: 'off' }]);
    expect(byId.get('notion')?.enabledAgents).toEqual([{ agentId: 'main', actionsPolicy: 'ask' }, { agentId: 'second', actionsPolicy: 'ask' }]);
    expect(byId.get('con-mine')?.category).toBe('custom');
    const workspace = byId.get('slack')?.installations[0];
    expect(workspace?.id).toBe('slack:T1');
    expect(workspace?.agents.map((entry) => [entry.agentId, entry.handle]).sort()).toEqual([['main', null], ['second', 'second']]);
    expect(byId.get('telegram')?.installations).toMatchObject([{ id: 'telegram:Bot', agentId: 'second' }]);
    // The other owner sees nothing of this.
    const theirs = await listApps({ store, channels: testChannels, catalog }, 'o2');
    expect(theirs.find((app) => app.id === 'slack')?.installations).toEqual([]);
    expect(theirs.find((app) => app.id === 'gmail')?.enabledAgents).toEqual([{ agentId: 'theirs', actionsPolicy: 'off' }]);
  });

  it('runs once: the marker makes a second run do nothing, and a setting the owner changed since is not put back', async () => {
    const store = await seeded();
    await migrateApps(store);
    await store.put('agentApps', { id: 'main:gmail', ownerId: 'o1', agentId: 'main', appId: 'gmail', enabled: true, actionsPolicy: 'allow', updatedAt: NOW });
    expect(await migrateApps(store)).toEqual({ skipped: true, policies: 0, stripped: 0, dmRows: 0 });
    expect(settingFor(await agentAppSettings(store, 'main'), 'gmail').actionsPolicy).toBe('allow');
    expect(MARKER).toBe('__migrations/apps-v1');
  });

  it('a row the owner set before the move is kept, not overwritten', async () => {
    const store = await seeded();
    await store.put('agentApps', { id: 'main:gmail', ownerId: 'o1', agentId: 'main', appId: 'gmail', enabled: true, actionsPolicy: 'allow', updatedAt: NOW });
    await migrateApps(store);
    expect(settingFor(await agentAppSettings(store, 'main'), 'gmail').actionsPolicy).toBe('allow');
    expect(settingFor(await agentAppSettings(store, 'second'), 'gmail').actionsPolicy).toBe('off');
  });
});
