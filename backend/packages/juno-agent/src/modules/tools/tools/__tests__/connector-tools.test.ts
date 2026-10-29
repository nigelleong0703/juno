/** connector_search and connect_request over the injected catalog: what the agent sees, and that a made-up or switched-off id is refused. */
import { describe, expect, it } from 'vitest';
import type { Enqueuer, Store, ToolContext, WakeEvent } from '../../../../contracts/index.js';
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { createMemoryStore } from '../../../../testing/store.js';
import { BUILTIN_CATALOG_ENTRIES, createConnectorCatalog } from '../../../mcp/catalog.js';
import { createConnectRequestTool } from '../connectRequest.js';
import { createConnectorSearchTool } from '../connectorSearch.js';

const OWNER = 'owner-1';
const catalog = createConnectorCatalog(BUILTIN_CATALOG_ENTRIES);

const enqueuer: Enqueuer = { async enqueue() { return { accepted: true }; }, async stopRun() {}, async resolveAwakeable() {}, async scheduleRoutine() {} };

function ctxFor(store: Store): ToolContext {
  const wake: WakeEvent = {
    id: 'wke-1', ownerId: OWNER, agentId: 'agent-1', sessionKey: 'agent-1:c1', conversationId: 'c1', kind: 'user_message',
    origin: { type: 'user', id: OWNER }, trusted: true, priority: 'user', payload: {}, at: '2026-10-19T00:00:00.000Z', status: 'accepted',
  };
  return { ownerId: OWNER, agentId: 'agent-1', conversationId: 'c1', runId: 'run-1', store, blobs: createMemoryBlobStore(), enqueuer, wake, step: async (_name, fn) => fn(), signal: new AbortController().signal };
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content.map((part) => part.text ?? '').join('\n');

async function seedConnected(store: Store, catalogId: string, ownerId = OWNER): Promise<void> {
  await store.put('connections', { id: 'conn-' + catalogId + ownerId, ownerId, catalogId, name: catalogId, status: 'connected', enabled: true } as never);
}

describe('connector_search', () => {
  it('lists matches with their state and ends with the connect_request line', async () => {
    const store = createMemoryStore();
    await seedConnected(store, 'gmail');
    await seedConnected(store, 'notion', 'someone-else');
    const tool = createConnectorSearchTool({ store, catalog, env: {} });
    const result = await tool.execute({ query: 'EMAIL' }, ctxFor(store));
    const out = text(result);
    expect(out).toMatch(/- gmail \| Gmail \| productivity \| connected \|/);
    expect(out).toMatch(/- outlook-mail \| Outlook Mail \| productivity \| needs_server \|/);
    expect(out.trim().split('\n').at(-1)).toContain('connect_request');
  });

  it('marks keyed entries without a key, and available ones that need no server client', async () => {
    const store = createMemoryStore();
    const missingKey = text(await createConnectorSearchTool({ store, catalog, env: {} }).execute({ query: 'google maps' }, ctxFor(store)));
    expect(missingKey).toMatch(/google-maps \| Google Maps \| travel \| needs_key/);
    const withKey = text(await createConnectorSearchTool({ store, catalog, env: { GOOGLE_MAPS_API_KEY: 'k' } }).execute({ query: 'google maps' }, ctxFor(store)));
    expect(withKey).toMatch(/google-maps \| Google Maps \| travel \| available/);
    const notion = text(await createConnectorSearchTool({ store, catalog, env: {} }).execute({ query: 'notion' }, ctxFor(store)));
    expect(notion).toMatch(/notion \| Notion \| productivity \| available/);
  });

  it('filters by category and connection, and caps the result', async () => {
    const store = createMemoryStore();
    await seedConnected(store, 'strava');
    const tool = createConnectorSearchTool({ store, catalog, env: {} });
    const health = text(await tool.execute({ category: 'health', only_unconnected: true }, ctxFor(store)));
    expect(health).toContain('hevy');
    expect(health).not.toContain('strava');
    const capped = text(await tool.execute({ limit: 2 }, ctxFor(store)));
    expect(capped.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
    expect(capped).toMatch(/\(\d+ more/);
    expect((await tool.execute({ limit: 26 }, ctxFor(store))).isError).toBe(true);
    expect(text(await tool.execute({ query: 'zzzz-no-such-app' }, ctxFor(store)))).toContain('No app in the catalog matches');
  });

  it('reads only the catalog it is given: a plugin that is off contributes nothing, a plugin\'s own entry is found', async () => {
    const store = createMemoryStore();
    const gmail = BUILTIN_CATALOG_ENTRIES.find((entry) => entry.id === 'gmail');
    const plugged = { id: 'acme-crm', name: 'Acme CRM', icon: 'crm', description: 'Customer records.', category: 'productivity' as const, url: 'https://mcp.acme.test/mcp' };
    const narrowed = createConnectorCatalog(gmail === undefined ? [plugged] : [gmail, plugged]);
    const tool = createConnectorSearchTool({ store, catalog: narrowed, env: {} });
    expect(text(await tool.execute({ query: 'acme' }, ctxFor(store)))).toMatch(/- acme-crm \| Acme CRM \| productivity \| available \|/);
    expect(text(await tool.execute({ query: 'notion' }, ctxFor(store)))).toContain('No app in the catalog matches');
    const off = createConnectorSearchTool({ store, catalog: createConnectorCatalog([]), env: {} });
    expect(text(await off.execute({ query: 'gmail' }, ctxFor(store)))).toContain('No app in the catalog matches');
  });
});

describe('connect_request validation', () => {
  it('refuses unknown ids, naming the closest known ones, and creates no card', async () => {
    const store = createMemoryStore();
    const result = await createConnectRequestTool({ store, catalog }).execute({ connectors: ['gmial', 'google-calendar'], label: 'Mail' }, ctxFor(store));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/gmial \(closest: gmail/);
    expect((await store.list('requests', { limit: 10 })).items).toHaveLength(0);
  });

  it('still creates the card for known ids', async () => {
    const store = createMemoryStore();
    const result = await createConnectRequestTool({ store, catalog }).execute({ connectors: ['gmail'], label: 'Gmail' }, ctxFor(store));
    expect(result.isError).toBeUndefined();
    expect((await store.list('requests', { limit: 10 })).items).toHaveLength(1);
  });

  it('refuses an id the catalog no longer has (its plugin is off) and creates no card', async () => {
    const store = createMemoryStore();
    const result = await createConnectRequestTool({ store, catalog: createConnectorCatalog([]) }).execute({ connectors: ['gmail'], label: 'Gmail' }, ctxFor(store));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not connector catalog ids on this deployment: gmail');
    expect((await store.list('requests', { limit: 10 })).items).toHaveLength(0);
  });
});

describe('apps per agent: added, turned on for this agent, signed in', () => {
  const off = (store: Store, appId: string) => store.put('agentApps', { id: 'agent-1:' + appId, ownerId: OWNER, agentId: 'agent-1', appId, enabled: false, actionsPolicy: 'ask', updatedAt: '2026-10-26T00:00:00.000Z' });

  it('connector_search tells an added app that is off for this agent from a connected one and from an expired one', async () => {
    const store = createMemoryStore();
    await seedConnected(store, 'gmail');
    await seedConnected(store, 'notion');
    await off(store, 'notion');
    await store.put('connections', { id: 'conn-linear', ownerId: OWNER, catalogId: 'linear', name: 'Linear', status: 'error', connectedAt: '2026-10-01T00:00:00.000Z', enabled: true } as never);
    const search = async (query: string) => text(await createConnectorSearchTool({ store, catalog, env: {} }).execute({ query }, ctxFor(store)));
    expect(await search('gmail')).toMatch(/- gmail \| Gmail \| productivity \| connected \|/);
    expect(await search('notion')).toMatch(/- notion \| Notion \| productivity \| turned_off \|/);
    expect(await search('linear')).toMatch(/- linear \| Linear \| projects \| expired \|/);
  });

  it('connect_request asks to turn an app on when it is only off for this agent, skips one the agent can use, and says why on the card', async () => {
    const store = createMemoryStore();
    await seedConnected(store, 'gmail');
    await seedConnected(store, 'notion');
    await off(store, 'notion');
    const tool = createConnectRequestTool({ store, catalog });
    expect(text(await tool.execute({ connectors: ['gmail'], label: 'Gmail' }, ctxFor(store)))).toContain('Already available');
    await tool.execute({ connectors: ['gmail', 'notion', 'linear'], label: 'Mail and notes' }, ctxFor(store));
    expect((await store.list('requests', { limit: 10 })).items).toMatchObject([{ payload: { appIds: ['notion', 'linear'], problems: { notion: 'not_enabled', linear: 'not_added' } } }]);
  });
});

describe('the Mac as a connect option', () => {
  const macOn = (online: boolean) => () => ({ macStatus: async () => ({ paired: true, online }) }) as never;
  const allow = (store: Store) => store.put('agents', { id: 'agent-1', name: 'Mira', macAccess: true } as never);

  it('creates a card for mac, offers it in connector_search, and says "Already connected" once the Mac is usable', async () => {
    const store = createMemoryStore();
    await allow(store);
    const offline = macOn(false);
    expect(text(await createConnectorSearchTool({ store, catalog, env: {}, computer: offline }).execute({ query: 'calendar' }, ctxFor(store)))).toContain("connect_request connectors:['mac']");
    const result = await createConnectRequestTool({ store, catalog, computer: offline }).execute({ connectors: ['mac'], label: 'Your Mac' }, ctxFor(store));
    expect(result.isError).toBeUndefined();
    expect((await store.list('requests', { limit: 10 })).items).toMatchObject([{ kind: 'connect', payload: { appIds: ['mac'], label: 'Your Mac' } }]);
    const online = macOn(true);
    expect(text(await createConnectRequestTool({ store, catalog, computer: online }).execute({ connectors: ['mac'], label: 'Your Mac' }, ctxFor(store)))).toContain('Already available');
    expect(text(await createConnectorSearchTool({ store, catalog, env: {}, computer: online }).execute({ query: 'calendar' }, ctxFor(store)))).not.toContain('Your Mac');
  });
});

describe('recommending catalog apps for a need', () => {
  const both = { GOOGLE_OAUTH_CLIENT_ID: 'g', GOOGLE_OAUTH_CLIENT_SECRET: 's', MICROSOFT_CLIENT_ID: 'm', MICROSOFT_CLIENT_SECRET: 's' };
  const cards = async (store: Store) => (await store.list('requests', { limit: 10 })).items;

  it('"send email" with no mail app: the apps that can send are offered (Gmail and Outlook Mail), as one card with the need in plain words', async () => {
    const store = createMemoryStore();
    const found = text(await createConnectorSearchTool({ store, catalog, env: both }).execute({ need: 'mail.send' }, ctxFor(store)));
    expect(found).toContain('Apps that can send email, best first:');
    expect(found).toMatch(/- outlook-mail \| Outlook Mail \| available/);
    expect(found).toMatch(/- gmail \| Gmail \| available/);
    expect((await createConnectRequestTool({ store, catalog, env: both }).execute({ need: 'mail.send' }, ctxFor(store))).isError).toBeUndefined();
    expect(await cards(store)).toMatchObject([{ kind: 'connect', payload: { appIds: expect.arrayContaining(['gmail', 'outlook-mail']), label: 'Send email', problems: { gmail: 'not_added', 'outlook-mail': 'not_added' } } }]);
  });

  it('an app whose OAuth client this deployment lacks is not offered for the need', async () => {
    const store = createMemoryStore();
    const found = text(await createConnectorSearchTool({ store, catalog, env: { MICROSOFT_CLIENT_ID: 'm', MICROSOFT_CLIENT_SECRET: 's' } }).execute({ need: 'mail.send' }, ctxFor(store)));
    expect(found).toMatch(/- outlook-mail \| Outlook Mail \| available/);
    expect(found).not.toContain('gmail');
  });

  it('a family ranks what only needs turning on or signing in again before what must be added, and an account already used before a new provider; connected means nothing to connect', async () => {
    const store = createMemoryStore();
    await seedConnected(store, 'google-calendar');
    await store.put('connections', { id: 'c-ol', ownerId: OWNER, catalogId: 'outlook-mail', name: 'Outlook Mail', status: 'error', connectedAt: '2026-10-01T00:00:00.000Z', enabled: true } as never);
    await createConnectRequestTool({ store, catalog, env: both }).execute({ need: 'mail' }, ctxFor(store));
    // Outlook needs signing in again (cheapest), then Gmail on the Google account the owner already uses.
    expect(await cards(store)).toMatchObject([{ payload: { appIds: ['outlook-mail', 'gmail'], problems: { 'outlook-mail': 'expired' } } }]);
    await seedConnected(store, 'gmail');
    expect(text(await createConnectorSearchTool({ store, catalog, env: both }).execute({ need: 'mail.read' }, ctxFor(store)))).toContain('You can already read email with: Gmail');
    expect(text(await createConnectRequestTool({ store, catalog, env: both }).execute({ need: 'mail.read' }, ctxFor(store)))).toContain('Already available');
  });

  it('never names an app outside the catalog: a capability nobody provides, an unknown tag, or an app this deployment cannot offer', async () => {
    const store = createMemoryStore();
    const search = createConnectorSearchTool({ store, catalog, env: {} });
    expect(text(await search.execute({ need: 'mail.send' }, ctxFor(store)))).toContain('No app in our catalog can send email on this deployment');
    const unknown = await search.execute({ need: 'teleport' }, ctxFor(store));
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('mail.send');
    expect((await createConnectRequestTool({ store, catalog, env: {} }).execute({ need: 'teleport' }, ctxFor(store))).isError).toBe(true);
    expect((await createConnectRequestTool({ store, catalog, env: {} }).execute({ connectors: ['gmail'] }, ctxFor(store))).isError).toBe(true);
    expect(await cards(store)).toEqual([]);
  });
});
