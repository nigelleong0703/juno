/**
 * The four chat platforms as plugins: each registers both layers under its kind, the core looks platforms up only through the plugin
 * host, and a platform whose plugin is disabled (`JUNO_PLUGINS`) is unavailable everywhere with a clear error: connect is refused,
 * inbound events are refused before anything is stored, nothing of it runs. Delivery, the ChannelPort and the working indicator
 * look-ups are covered next to their own tests (delivery.test.ts, chat-abilities.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createMemoryStore } from '@agent-desktop/db';
import type { ChannelRow, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { createPluginHost } from '../../plugins/host.js';
import { pluginRowsFromEnv } from '../../plugins/config.js';
import { channelPlugins } from '../../plugins/builtin.js';
import type { Services } from '../../plugins/services.js';
import { createTestApp, loadTestChannels, loadTestPlatforms, ownerHeaders, testChannels, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import { channelRegistryOf } from '../registry.js';
import { startChannelRunners, type ChannelRunner } from '../runners.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-22T00:00:00.000Z';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

class RecordingEnqueuer implements Enqueuer {
  wakes: WakeEvent[] = [];
  async enqueue(event: WakeEvent): Promise<{ accepted: boolean }> {
    this.wakes.push(event);
    return { accepted: true };
  }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

describe('platform plugins', () => {
  it('each platform is one plugin named by its kind, registering the transport, the abilities, a connector and its runners', async () => {
    const host = createPluginHost<Services>({ log: silent });
    // The Discord plugin injects the store and the enqueuer (its voice holder is built from them); these tests never run a gateway.
    host.provide('store', {} as Services['store']);
    host.provide('enqueuer', {} as Services['enqueuer']);
    for (const plugin of channelPlugins) host.use(plugin);
    await host.load();
    expect(host.status().map((s) => [s.name, s.state])).toEqual([['telegram', 'active'], ['slack', 'active'], ['discord', 'active'], ['feishu', 'active']]);
    const registry = channelRegistryOf(host);
    expect(registry.all().map((registration) => registration.kind)).toEqual(['telegram', 'slack', 'discord', 'feishu']);
    for (const registration of registry.all()) {
      expect(typeof registration.adapter.transport.sender).toBe('function');
      expect(typeof registration.adapter.abilities.react).toBe('function');
      expect(typeof registration.connector.connect).toBe('function');
    }
    expect(Object.fromEntries(registry.all().map((registration) => [registration.kind, registration.workingIndicator]))).toEqual({ telegram: false, slack: true, discord: true, feishu: true });
    expect(Object.fromEntries(registry.all().map((registration) => [registration.kind, registration.runners?.length ?? 0]))).toEqual({ telegram: 2, slack: 0, discord: 1, feishu: 1 });
  });

  it('JUNO_PLUGINS switches one platform off and leaves the others', async () => {
    const rows = pluginRowsFromEnv({ JUNO_PLUGINS: '{"discord":{"enabled":false}}' });
    const host = createPluginHost<Services>({ log: silent, rows });
    // The Discord plugin injects the store and the enqueuer (its voice holder is built from them); these tests never run a gateway.
    host.provide('store', {} as Services['store']);
    host.provide('enqueuer', {} as Services['enqueuer']);
    for (const plugin of channelPlugins) host.use(plugin);
    await host.load();
    expect(host.status().find((s) => s.name === 'discord')?.state).toBe('disabled');
    const registry = channelRegistryOf(host);
    expect(registry.get('discord')).toBeUndefined();
    expect(registry.senders()('discord')).toBeUndefined();
    expect(registry.all().map((registration) => registration.kind)).toEqual(['telegram', 'slack', 'feishu']);
  });

  it('starts the runners of the registered platforms only, plus the always-on sweeper', async () => {
    const started: string[] = [];
    const spy = (name: string): ChannelRunner => ({ start: () => { started.push(name); return () => { started.push('stop ' + name); }; } });
    const host = createPluginHost<Services>({ log: silent, rows: { discord: { enabled: false } } });
    host.use({ name: 'telegram', apply(ctx) { const real = testChannels.get('telegram'); if (real) ctx.channels.register({ ...real, runners: [spy('telegram poller')] }); } });
    host.use({ name: 'discord', apply(ctx) { const real = testChannels.get('discord'); if (real) ctx.channels.register({ ...real, runners: [spy('discord gateway')] }); } });
    await host.load();
    const stop = startChannelRunners({ store: createMemoryStore(), enqueuer: new RecordingEnqueuer(), channels: channelRegistryOf(host) });
    expect(started).toEqual(['telegram poller']);
    stop();
    expect(started).toEqual(['telegram poller', 'stop telegram poller']);
  });
});

describe('a disabled platform plugin', () => {
  let store: Store;
  let enqueuer: RecordingEnqueuer;

  const channel = (kind: string): ChannelRow => ({
    id: kind + ':chan-1', ownerId: OWNER, agentId: 'agent-1', kind, channelId: 'chan-1',
    secretHashHex: createHash('sha256').update('s').digest('hex'), ownerExternalId: 'user-7', createdAt: AT, updatedAt: AT,
  });

  async function appWith(channels: Awaited<ReturnType<typeof loadTestChannels>>) {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    enqueuer = new RecordingEnqueuer();
    await store.put('agents', {
      id: 'agent-1', name: 'Agent 1', handle: 'agent-1', avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent', status: 'idle', section: 'Inbox',
      pinned: false, lastActivity: 'Just created', unreadCount: 0,
      model: { planner: { provider: 'openai', model: 'm' }, computer: { provider: 'openai', model: 'm' }, fast: { provider: 'openai', model: 'm' } },
      channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: OWNER, createdAt: AT, updatedAt: AT,
    });
    await store.put('channels', channel('telegram'));
    await store.put('channels', channel('discord'));
    return createTestApp({ store, bus: mem.eventBus, enqueuer, channels });
  }

  const post = (app: Awaited<ReturnType<typeof appWith>>, path: string, body: unknown) =>
    Promise.resolve(app.request(path, { method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify(body) }));

  it('refuses to connect with a clear error, while the other platforms still connect', async () => {
    const app = await appWith(await loadTestChannels({ discord: { enabled: false } }));
    const refused = await post(app, '/v1/apps/discord/install', { botToken: 'x', agentId: 'agent-1' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: { code: 'UNSUPPORTED_CHANNEL', message: expect.stringMatching(/discord platform is not available.*plugin is disabled/) } });
    // Telegram's connector is reached (it fails on its own missing token, not on availability).
    const other = await post(app, '/v1/apps/telegram/install', { agentId: 'agent-1' });
    expect(other.status).toBe(400);
    expect(JSON.stringify(await other.json())).not.toContain('not available on this server');
  });

  it('refuses inbound events of its existing channels before storing anything or waking the agent', async () => {
    const event = { chatType: 'private', threadId: 'dm', chatId: 'dm', text: 'hello', externalMessageId: 'm-1', from: { id: 'user-7' } };
    const off = await appWith(await loadTestChannels({ discord: { enabled: false } }));
    const refused = await post(off, '/v1/channels/discord/chan-1/events', event);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: { code: 'CHANNEL_PLATFORM_UNAVAILABLE', message: expect.stringMatching(/discord platform is not available/) } });
    expect(enqueuer.wakes).toHaveLength(0);
    expect((await store.list('items', { limit: 10 })).items).toHaveLength(0);
    // The same event on a platform that is on is admitted.
    expect((await post(off, '/v1/channels/telegram/chan-1/events', event)).status).toBe(202);
    expect(enqueuer.wakes).toHaveLength(1);
  });
});

/**
 * A platform's own HTTP routes are mounted by its plugin (`ctx.http.route`): with the plugin off they are absent, so the path
 * answers Hono's 404 ("404 Not Found"); with it on, the route answers with its own body.
 */
describe('a disabled platform takes its own HTTP routes with it', () => {
  const OWNER_ID = 'owner-7';
  async function appFor(rows: Parameters<typeof loadTestPlatforms>[0]) {
    const mem = createMemoryStore();
    const platforms = await loadTestPlatforms(rows);
    return createTestApp({ store: withDefaultOwner(mem, OWNER_ID), bus: mem.eventBus, enqueuer: new RecordingEnqueuer(), ...platforms });
  }
  const call = async (app: Awaited<ReturnType<typeof appFor>>, method: string, path: string) => {
    const response = await Promise.resolve(app.request(path, { method, headers: ownerHeaders(OWNER_ID, method !== 'GET'), ...(method === 'GET' ? {} : { body: '{}' }) }));
    return { status: response.status, text: await response.text() };
  };

  it('Slack: the shared events URL and the install redirect are gone when the plugin is off', async () => {
    const app = await appFor({ slack: { enabled: false } });
    expect(await call(app, 'POST', '/v1/channels/slack/events')).toEqual({ status: 404, text: '404 Not Found' });
    expect(await call(app, 'GET', '/v1/channels/slack/oauth/callback')).toEqual({ status: 404, text: '404 Not Found' });
    // The other platform's redirect is still mounted and answers in its own words.
    expect((await call(app, 'GET', '/v1/channels/discord/oauth/callback')).text).toContain('install link is not valid');
  });

  it('Slack: the same routes answer when the plugin is on', async () => {
    const app = await appFor({});
    expect((await call(app, 'POST', '/v1/channels/slack/events')).text).toContain('INSTALLATION_NOT_FOUND');
  });

  it('Discord: its install redirect is gone when the plugin is off, and the Slack routes stay', async () => {
    const app = await appFor({ discord: { enabled: false } });
    expect(await call(app, 'GET', '/v1/channels/discord/oauth/callback')).toEqual({ status: 404, text: '404 Not Found' });
    expect((await call(app, 'POST', '/v1/channels/slack/events')).text).toContain('INSTALLATION_NOT_FOUND');
  });
});
