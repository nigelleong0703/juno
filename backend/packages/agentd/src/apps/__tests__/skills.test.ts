/**
 * The skills an app package ships (BACKEND 10.18) are platform skill rows of source `app:<appId>` (BACKEND 5.15), on a real embedded Postgres:
 * writing a package seeds them, an unchanged text is not a new version, and an agent can read one only while the owner has the app added and
 * turned on for it (and the catalog still has it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { createPlatformSkillsService, platformSkillsDir, type PlatformSkillsService } from '@agent-desktop/memory-graph/skills';
import { startTestDatabase, type TestDatabase } from '@agent-desktop/memory-graph/testing';
import { setAgentApp } from 'juno-agent/modules/apps/agent-apps';
import { appCatalogCreateSchema, createStoredCatalog, type StoredCatalog } from 'juno-agent/modules/apps/catalog';
import type { Store } from 'juno-agent/contracts';
import { webSeedRows } from '../seed.js';
import { appSkillFiles, appSkillGate, syncAppSkills } from '../skills.js';
import { addWebApp } from '../web.js';

const OWNER = 'owner-skills';
const pack = {
  id: 'acme-crm', category: 'work',
  interface: { displayName: 'Acme CRM', shortDescription: 'Customers.', longDescription: 'Customers and deals.', icon: 'crm', defaultPrompts: [] },
  mcpServers: { acme: { type: 'streamable-http', url: 'https://mcp.acme.test/mcp', auth: 'oauth' } },
  skills: [
    { name: 'pipeline-review', description: 'Review the pipeline. Use when asked how deals are going.', instructions: 'List open deals by stage.' },
    { name: 'welcome', description: 'First steps after adding Acme.', instructions: 'Say hello, list the queues.' },
  ],
  onboardingSkill: 'welcome',
};

let database: TestDatabase;
let platform: PlatformSkillsService;
let store: Store;
let catalog: StoredCatalog;

beforeAll(async () => {
  database = await startTestDatabase();
  store = createMemoryStore();
  const bound: { current?: StoredCatalog } = {};
  platform = createPlatformSkillsService(database.db, { gate: appSkillGate({ store: () => store, catalog: () => bound.current }) });
  catalog = await createStoredCatalog({ store, seed: [], afterWrite: async (row) => { await syncAppSkills(platform, [row]); } });
  bound.current = catalog;
}, 120_000);

afterAll(async () => { await database.close(); });

const read = (name: string, agentId = 'agent-a') => platform.resolve(name, 'run-1', { ownerId: OWNER, agentId });
const addApp = () => store.put('connections', { id: 'con-acme', kind: 'mcp', name: 'Acme CRM', status: 'connected', enabled: true, ownerId: OWNER, catalogId: 'acme-crm' } as never);

describe('app skill packs in the platform skill store', () => {
  it('a package maps to platform skill files: onboarding skill first, source app:<id>, a name per app so two apps can both ship a triage', () => {
    const files = appSkillFiles({ appId: 'acme-crm', skills: pack.skills, onboardingSkill: 'welcome', status: 'listed' });
    expect(files.map((file) => [file.id, file.name, file.source])).toEqual([
      ['app-acme-crm-welcome', 'acme-crm/welcome', 'app:acme-crm'],
      ['app-acme-crm-pipeline-review', 'acme-crm/pipeline-review', 'app:acme-crm'],
    ]);
    expect(appSkillFiles({ appId: 'acme-crm', skills: pack.skills, status: 'retired' })).toEqual([]);
  });

  it('writing the package seeds its skills; nobody can read them until the owner has added the app', async () => {
    expect(await catalog.create(appCatalogCreateSchema.parse(pack))).toMatchObject({ ok: true });
    expect(await read('acme-crm/pipeline-review')).toBeNull();
    await addApp();
    expect(await read('acme-crm/pipeline-review')).toMatchObject({ skillId: 'app-acme-crm-pipeline-review', source: 'app:acme-crm', instructions: 'List open deals by stage.' });
    // Found by its id too, as for any platform skill.
    expect(await read('app-acme-crm-welcome')).toMatchObject({ name: 'acme-crm/welcome' });
  });

  it('turned off for one agent, only that agent loses it; another owner never had it', async () => {
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-a', appId: 'acme-crm', enabled: false, actionsPolicy: 'ask' });
    expect(await read('acme-crm/pipeline-review', 'agent-a')).toBeNull();
    expect(await read('acme-crm/pipeline-review', 'agent-b')).not.toBeNull();
    expect(await platform.resolve('acme-crm/pipeline-review', 'run-1', { ownerId: 'someone-else', agentId: 'agent-a' })).toBeNull();
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-a', appId: 'acme-crm', enabled: true, actionsPolicy: 'ask' });
    expect(await read('acme-crm/pipeline-review', 'agent-a')).not.toBeNull();
  });

  it('an edit that changes a skill is a new version of it; one that leaves its text alone is not', async () => {
    const before = await platform.active('app-acme-crm-pipeline-review');
    expect(await catalog.update('acme-crm', { keywords: ['crm'] })).toMatchObject({ ok: true });
    expect((await platform.active('app-acme-crm-pipeline-review'))?.version).toBe(before?.version);
    const skills = [{ ...pack.skills[0], instructions: 'List open deals by stage, then flag the stale ones.' }, pack.skills[1]];
    expect(await catalog.update('acme-crm', { skills: skills as never })).toMatchObject({ ok: true });
    const after = await platform.active('app-acme-crm-pipeline-review');
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.instructions).toContain('flag the stale ones');
    expect((await read('acme-crm/pipeline-review'))?.instructions).toContain('flag the stale ones');
  });

  it('a retired app\'s skills cannot be read any more, though the owner still has the connection', async () => {
    expect(await catalog.retire('acme-crm')).toMatchObject({ ok: true });
    expect(await read('acme-crm/pipeline-review')).toBeNull();
    expect(await read('acme-crm/welcome')).toBeNull();
    // Brought back, they read again.
    await catalog.update('acme-crm', { status: 'listed' });
    expect(await read('acme-crm/welcome')).not.toBeNull();
  });

  it('a web app ships its channel\'s skill with the shared rules; it reads only while the owner has added the app and it is on for the agent', async () => {
    const seeded = (await webSeedRows(platformSkillsDir())).find((row) => row.appId === 'youtube-videos');
    if (seeded === undefined) throw new Error('the web seeds are missing');
    const { id: rowId, ownerId, appId, version, ...rest } = seeded;
    void rowId; void ownerId; void version;
    expect(await catalog.create(appCatalogCreateSchema.parse({ ...rest, id: appId }))).toMatchObject({ ok: true });
    expect(await read('youtube-videos/agent-reach')).toBeNull();
    const installation = await addWebApp(store, OWNER, seeded);
    const skill = await read('youtube-videos/agent-reach');
    expect(skill).toMatchObject({ source: 'app:youtube-videos', name: 'youtube-videos/agent-reach' });
    expect(skill?.instructions).toContain('agent-reach youtube subtitle');
    expect(skill?.instructions).toContain('PLATFORM_BLOCKED');
    await setAgentApp(store, { ownerId: OWNER, agentId: 'agent-a', appId: 'youtube-videos', enabled: false, actionsPolicy: 'ask' });
    expect(await read('youtube-videos/agent-reach', 'agent-a')).toBeNull();
    expect(await read('youtube-videos/agent-reach', 'agent-b')).not.toBeNull();
    // Removed (the gateway disconnects the row): nobody reads it.
    await store.patch('connections', installation.id, { status: 'disconnected', enabled: false } as never);
    expect(await read('youtube-videos/agent-reach', 'agent-b')).toBeNull();
    // Adding it again turns the same row back on.
    expect((await addWebApp(store, OWNER, seeded)).id).toBe(installation.id);
    expect(await read('youtube-videos/agent-reach', 'agent-b')).not.toBeNull();
  });

  it('the gate says no to anything that is not an app source', async () => {
    const gate = appSkillGate({ store: () => store, catalog: () => catalog });
    expect(await gate('image', { ownerId: OWNER, agentId: 'agent-a' })).toBe(false);
    expect(await gate('app:acme-crm', { ownerId: OWNER, agentId: 'agent-a' })).toBe(true);
    expect(await gate('app:unknown', { ownerId: OWNER, agentId: 'agent-a' })).toBe(false);
  });
});
