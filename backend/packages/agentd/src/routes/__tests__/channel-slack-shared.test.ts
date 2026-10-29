/**
 * The shared Juno Slack app: OAuth install makes one installation per workspace and a user group per agent; events are routed by
 * workspace and user group mention; replies carry the agent's own name and picture; a free workspace keeps working without handles
 * and gets them automatically after an upgrade. Slack is a fake fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import { appDetailSchema, installAppResponseSchema, type Agent } from '@agent-desktop/public-contracts';
import { replyOriginOf } from 'juno-agent/modules/channel-origin';
import { createMemoryBlobStore } from 'juno-agent/testing/blobs';
import { createTestApp, ownerHeaders, testChannels, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import { deliverChannelReply } from '../../channels/delivery.js';
import { handleSlug, retryMissingHandles } from '../../channels/slack/shared.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-19T00:00:00.000Z';

function makeAgent(id: string, name: string, createdAt: string): Agent {
  return {
    id, name, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent',
    status: 'idle', section: 'Inbox', pinned: false, lastActivity: 'Just created', unreadCount: 0,
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt, updatedAt: createdAt,
  } as Agent;
}

interface Call { method: string; auth: string | null; form: URLSearchParams; json: Record<string, unknown> }

describe('shared Slack app', () => {
  let app: Hono;
  let store: Store;
  let wakes: WakeEvent[];
  let calls: Call[];
  let groupError: string | undefined;
  let takenHandles: Set<string>;
  let groups: number;

  const enqueuer: Enqueuer = {
    enqueue: async (wake) => { wakes.push(wake); return { accepted: true }; },
    stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined,
  };

  const fakeSlack: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // A Slack-hosted file (url_private) answers its bytes.
    if (url.startsWith('https://files.slack.com/')) return new Response('hello', { headers: { 'content-type': 'text/plain' } });
    const method = url.split('/api/')[1] ?? '';
    const raw = typeof init?.body === 'string' ? init.body : '';
    const isJson = (new Headers(init?.headers).get('content-type') ?? '').includes('json');
    calls.push({ method, auth: new Headers(init?.headers).get('authorization'), form: new URLSearchParams(isJson ? '' : raw), json: isJson ? (JSON.parse(raw) as Record<string, unknown>) : {} });
    const form = new URLSearchParams(isJson ? '' : raw);
    if (method === 'oauth.v2.access') {
      if (form.get('code') !== 'good') return Response.json({ ok: false, error: 'invalid_code' });
      return Response.json({ ok: true, access_token: 'xoxb-shared', bot_user_id: 'UBOT', team: { id: 'T1', name: 'Acme' }, authed_user: { id: 'UOWNER' } });
    }
    if (method === 'usergroups.create') {
      if (groupError) return Response.json({ ok: false, error: groupError });
      const handle = form.get('handle') ?? '';
      if (takenHandles.has(handle)) return Response.json({ ok: false, error: 'handle_already_exists' });
      groups += 1;
      return Response.json({ ok: true, usergroup: { id: 'S' + String(groups), handle } });
    }
    if (method === 'chat.postMessage') return Response.json({ ok: true, ts: '9.9' });
    return Response.json({ ok: false, error: 'unknown_method' });
  };

  /** Installs the Juno app into a workspace: `agentId` is the agent that is enabled there first. */
  const connect = (agentId: string, body: Record<string, unknown> = { mode: 'oauth' }) =>
    Promise.resolve(app.request('/v1/apps/slack/install', { method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ ...body, agentId }) }));
  /** Enables an agent in the installed workspace. */
  const enable = (agentId: string, enabled = true) =>
    Promise.resolve(app.request('/v1/apps/slack/installations/slack:T1/agents/' + agentId, { method: 'PUT', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ enabled }) }));
  const detail = async () => appDetailSchema.parse(await (await app.request('/v1/apps/slack', { headers: ownerHeaders(OWNER) })).json());
  const callback = (state: string) => Promise.resolve(app.request('/v1/channels/slack/oauth/callback?code=good&state=' + state, { headers: ownerHeaders(OWNER) }));
  const event = (body: Record<string, unknown>) =>
    Promise.resolve(app.request('/v1/channels/slack/events', { method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: 'E' + String(Math.random()), event: { ts: '100.1', ...body } }) }));
  /** What the Apps page shows for an agent in the workspace. */
  const channels = async (agentId: string) => (await detail()).installations.flatMap((installation) => installation.agents.filter((agent) => agent.agentId === agentId));

  async function install(): Promise<void> {
    const res = await connect('nova');
    expect(res.status).toBe(202);
    const body = installAppResponseSchema.parse(await res.json());
    expect((await callback(body.pending?.id ?? '')).status).toBe(200);
  }

  beforeEach(async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 6).toString('base64'));
    vi.stubEnv('CHANNELS_PUBLIC_URL', 'https://hooks.example.com');
    vi.stubEnv('SLACK_CLIENT_ID', 'CID.shared');
    vi.stubEnv('SLACK_CLIENT_SECRET', 'csecret');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'ssecret');
    vi.stubEnv('CHANNELS_AVATAR_BASE_URL', 'https://cdn.example.com/avatars/');
    wakes = [];
    calls = [];
    groupError = undefined;
    takenHandles = new Set();
    groups = 0;
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    app = createTestApp({ store, bus: mem.eventBus, enqueuer, channelFetch: fakeSlack, blobs: createMemoryBlobStore() });
    await store.put('agents', makeAgent('juno', 'Juno', '2026-10-01T00:00:00.000Z'));
    await store.put('agents', makeAgent('nova', 'Nova', '2026-10-02T00:00:00.000Z'));
    return () => { vi.unstubAllEnvs(); };
  });

  it('builds handles from agent names', () => {
    expect(handleSlug('Nova')).toBe('nova');
    expect(handleSlug('Dr. Lee Ünal!')).toBe('dr-lee-unal');
    expect(handleSlug('???')).toBe('agent');
  });

  it('needs the shared app configured', async () => {
    vi.stubEnv('SLACK_CLIENT_ID', '');
    const res = await connect('nova');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SHARED_APP_NOT_CONFIGURED');
  });

  it('installs through OAuth: one installation per workspace, a user group and an auto-bound owner for the agent', async () => {
    const res = await connect('nova');
    const body = installAppResponseSchema.parse(await res.json());
    const install = new URL(body.openUrl ?? '');
    expect(install.searchParams.get('client_id')).toBe('CID.shared');
    const scopes = (install.searchParams.get('scope') ?? '').split(',');
    expect(scopes).toEqual(expect.arrayContaining(['usergroups:write', 'usergroups:read', 'chat:write.customize', 'channels:history', 'groups:history', 'im:history', 'app_mentions:read', 'reactions:write', 'files:read', 'files:write']));
    expect(install.searchParams.get('redirect_uri')).toBe('https://hooks.example.com/v1/channels/slack/oauth/callback');
    expect((await callback(body.pending?.id ?? '')).status).toBe(200);

    const installation = await store.get('channelInstallations', 'slack:T1');
    expect(installation).toMatchObject({ ownerId: OWNER, kind: 'slack', teamId: 'T1', botUserId: 'UBOT', installedBy: 'UOWNER' });
    expect(decryptSecret(installation?.botToken ?? '')).toBe('xoxb-shared');
    const create = calls.find((call) => call.method === 'usergroups.create');
    expect(create?.auth).toBe('Bearer xoxb-shared');
    expect(create?.form.get('handle')).toBe('nova');
    expect(create?.form.get('name')).toBe('Nova');
    const row = await store.get('channels', 'slack:T1.nova');
    expect(row).toMatchObject({ installationId: 'slack:T1', usergroupId: 'S1', handle: 'nova', handleStatus: 'ok', ownerExternalId: 'UOWNER', agentId: 'nova' });
    expect(row?.botToken).toBeUndefined();
    expect(await channels('nova')).toEqual([{ agentId: 'nova', handle: 'nova', handleStatus: 'ok' }]);
    const shown = (await detail()).installations;
    expect(shown).toMatchObject([{ id: 'slack:T1', appId: 'slack', label: 'Acme', status: 'connected', bound: true }]);
    expect(shown[0]?.agentId).toBeUndefined();
  });

  it('enables a second agent in the workspace without another install, suffixing a taken handle, and takes it out again', async () => {
    await install();
    takenHandles.add('juno');
    const res = await enable('juno');
    expect(res.status).toBe(200);
    expect(calls.filter((call) => call.method === 'oauth.v2.access')).toHaveLength(1);
    expect(await store.get('channels', 'slack:T1.juno')).toMatchObject({ handle: 'juno-2', usergroupId: 'S2' });
    expect(((await res.json()) as { items: Array<{ agentId: string }> }).items.map((agent) => agent.agentId).sort()).toEqual(['juno', 'nova']);
    expect((await detail()).enabledAgents.map((agent) => agent.agentId).sort()).toEqual(['juno', 'nova']);
    // Turning it off switches its user group off and removes its row; the other agent stays.
    expect((await enable('juno', false)).status).toBe(200);
    expect(calls.find((call) => call.method === 'usergroups.disable')?.form.get('usergroup')).toBe('S2');
    expect(await store.get('channels', 'slack:T1.juno')).toBeNull();
    expect(await store.get('channels', 'slack:T1.nova')).not.toBeNull();
  });

  it('refuses to enable an agent in a workspace that is not installed, and to enable it for someone else\'s agent', async () => {
    await install();
    expect((await app.request('/v1/apps/slack/installations/slack:T404/agents/nova', { method: 'PUT', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ enabled: true }) })).status).toBe(404);
    expect((await app.request('/v1/apps/slack/installations/slack:T1/agents/ghost', { method: 'PUT', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ enabled: true }) })).status).toBe(404);
    expect((await app.request('/v1/apps/slack/installations/slack:T1/agents/nova', { method: 'PUT', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ enabled: 'yes' }) })).status).toBe(400);
  });

  it('removing the workspace removes every agent\'s row and the installation', async () => {
    await install();
    await enable('juno');
    expect((await app.request('/v1/apps/slack/installations/slack:T1', { method: 'DELETE', headers: ownerHeaders(OWNER) })).status).toBe(204);
    expect(await store.get('channelInstallations', 'slack:T1')).toBeNull();
    expect(await store.get('channels', 'slack:T1.nova')).toBeNull();
    expect(await store.get('channels', 'slack:T1.juno')).toBeNull();
    expect((await detail()).installations).toEqual([]);
  });

  it('routes a user group mention to its agent and DMs or plain mentions to the main agent', async () => {
    await install();
    await enable('juno');
    // The second group is S2 (juno), the first S1 (nova).
    expect((await event({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'UOWNER', text: '<!subteam^S1|@nova> do the thing' })).status).toBe(202);
    expect(wakes[0]).toMatchObject({ agentId: 'nova', kind: 'room_mention', payload: { text: 'do the thing', chatId: 'C1', channelKind: 'slack' } });
    expect((await event({ type: 'message', channel_type: 'im', channel: 'D1', user: 'UOWNER', text: 'private note', ts: '101.1' })).status).toBe(202);
    expect(wakes[1]).toMatchObject({ agentId: 'juno', kind: 'user_message' });
    expect((await event({ type: 'app_mention', channel: 'C1', user: 'UOWNER', text: '<@UBOT> hello app', ts: '102.1' })).status).toBe(202);
    expect(wakes[2]).toMatchObject({ agentId: 'juno', payload: { text: 'hello app' } });
    // Channel chatter without a mention, the bot's own messages and unknown workspaces are not heard.
    expect((await event({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'UOWNER', text: 'just talking', ts: '103.1' })).status).toBe(200);
    expect((await event({ type: 'message', channel_type: 'im', channel: 'D1', user: 'UBOT', text: 'echo', ts: '104.1' })).status).toBe(200);
    expect(wakes).toHaveLength(3);
  });

  it('acknowledges a message with files at once (inside Slack\'s 3 seconds) and wakes the agent after the file is stored', async () => {
    await install();
    await enable('juno');
    const res = await event({ type: 'message', channel_type: 'im', channel: 'D1', user: 'UOWNER', text: 'see the file', ts: '105.1', files: [{ id: 'F1', name: 'notes.txt', mimetype: 'text/plain', size: 5, url_private: 'https://files.slack.com/files-pri/T1-F1/notes.txt' }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    // The admission runs after the answer; the wake names the stored file.
    for (let i = 0; i < 200 && wakes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(wakes[0]).toMatchObject({ agentId: 'juno', kind: 'user_message', payload: { text: 'see the file', attachmentIds: [expect.any(String)] } });
    const unknown = await app.request('/v1/channels/slack/events', { method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ team_id: 'T404', event: {} }) });
    expect(unknown.status).toBe(404);
  });

  it('posts as the agent: its name and picture ride on chat.postMessage', async () => {
    await install();
    await event({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'UOWNER', text: '<!subteam^S1> go' });
    const wake = wakes[0] as WakeEvent;
    const replyTo = replyOriginOf([wake]);
    const conversationId = wake.conversationId ?? '';
    await store.put('items', { id: 'itm-r', conversationId, type: 'agent_message', at: AT, agentId: 'nova', markdown: 'done', citations: [], ...(replyTo ? { replyTo } : {}) });
    calls.length = 0;
    const outcome = await deliverChannelReply(store, testChannels.senders(fakeSlack), { ownerId: OWNER, conversationId, itemId: 'itm-r' });
    expect(outcome.status).toBe('sent');
    const post = calls.find((call) => call.method === 'chat.postMessage');
    expect(post?.auth).toBe('Bearer xoxb-shared');
    expect(post?.json).toMatchObject({ channel: 'C1', username: 'Nova', icon_url: expect.stringMatching(/^https:\/\/cdn\.example\.com\/avatars\/[a-z]+\.png$/), thread_ts: '100.1' });
  });

  it('keeps a free workspace working without handles and turns them on after the upgrade', async () => {
    groupError = 'paid_teams_only';
    await install();
    const row = await store.get('channels', 'slack:T1.nova');
    expect(row).toMatchObject({ handleStatus: 'needs_paid_plan', installationId: 'slack:T1' });
    expect(row?.handle).toBeUndefined();
    const [view] = await channels('nova');
    expect(view).toMatchObject({ handle: null, handleStatus: 'needs_paid_plan' });
    expect(view?.statusMessage).toContain("Free Slack can't give each agent its own @name");

    // Mentions of the app and DMs still reach an enabled agent while no handle exists (the main agent when it is enabled in the workspace, else the one that is).
    expect((await event({ type: 'app_mention', channel: 'C1', user: 'UOWNER', text: '<@UBOT> are you there' })).status).toBe(202);
    expect(wakes[0]).toMatchObject({ agentId: 'nova' });

    // The workspace upgrades. Within a day nothing is retried; after it the next event creates the groups.
    groupError = undefined;
    const tries = () => calls.filter((call) => call.method === 'usergroups.create').length;
    const before = tries();
    await event({ type: 'app_mention', channel: 'C1', user: 'UOWNER', text: '<@UBOT> again', ts: '200.1' });
    expect(tries()).toBe(before);
    const installation = await store.get('channelInstallations', 'slack:T1');
    await store.put('channelInstallations', { ...(installation as NonNullable<typeof installation>), handlesCheckedAt: '2020-01-01T00:00:00.000Z' });
    await event({ type: 'app_mention', channel: 'C1', user: 'UOWNER', text: '<@UBOT> and again', ts: '300.1' });
    expect(tries()).toBeGreaterThan(before);
    expect(await store.get('channels', 'slack:T1.nova')).toMatchObject({ handle: 'nova', handleStatus: 'ok', usergroupId: expect.stringMatching(/^S/) });
    const [after] = await channels('nova');
    expect(after).toMatchObject({ handle: 'nova', handleStatus: 'ok' });
    expect(after?.statusMessage).toBeUndefined();
    // Nothing to retry once every agent has its group.
    const fresh = await store.get('channelInstallations', 'slack:T1');
    const count = tries();
    await retryMissingHandles({ store, channelFetch: fakeSlack }, { ...(fresh as NonNullable<typeof fresh>), handlesCheckedAt: undefined }, Date.now() + 2 * 86_400_000);
    expect(tries()).toBe(count);
  });
});
