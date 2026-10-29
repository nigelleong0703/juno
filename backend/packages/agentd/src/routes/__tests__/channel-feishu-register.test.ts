/**
 * CH7 Feishu / Lark registerApp: the verification link, the background poll that writes the row, auto-bind
 * (approver open_id, else the owner's account email), failure. The SDK's registerApp is a fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { ChannelRow, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import { appDetailSchema, installAppResponseSchema, type Agent } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import { feishuConnector } from '../../channels/feishu/connect.js';
import type { AgentdDeps, FeishuRegisterApp } from '../index.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-19T00:00:00.000Z';

function makeAgent(id: string): Agent {
  return {
    id, name: 'Agent ' + id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test agent',
    status: 'idle', section: 'Inbox', pinned: false, lastActivity: 'Just created', unreadCount: 0,
    model: {
      planner: { provider: 'openai', model: 'gpt-4' },
      computer: { provider: 'openai', model: 'gpt-4-vision' },
      fast: { provider: 'openai', model: 'gpt-3.5-turbo' },
    },
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt: AT, updatedAt: AT,
  };
}

class RecordingEnqueuer implements Enqueuer {
  wakes: WakeEvent[] = [];
  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string }> {
    this.wakes.push(event);
    return { accepted: true };
  }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}


type RegisterResult = Awaited<ReturnType<FeishuRegisterApp>>;

describe('feishu registerApp', () => {
  let app: Hono;
  let store: Store;
  let finishFlow: (result: RegisterResult) => void;
  let failFlow: (error: Error) => void;
  let registerOptions: Parameters<FeishuRegisterApp>[0] | undefined;
  let failBeforeLink = false;

  const fakeRegister: FeishuRegisterApp = (options) => {
    registerOptions = options;
    if (failBeforeLink) return Promise.reject(new Error('network down'));
    options.onQRCodeReady({ url: 'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD', expireIn: 600 });
    return new Promise<RegisterResult>((resolve, reject) => { finishFlow = resolve; failFlow = reject; });
  };

  const connect = (body: unknown): Promise<Response> =>
    Promise.resolve(app.request('/v1/apps/feishu/install', { method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ ...(body as Record<string, unknown>), agentId: 'agent-1' }) }));
  const detail = async () => appDetailSchema.parse(await (await app.request('/v1/apps/feishu', { headers: ownerHeaders(OWNER) })).json());
  const poll = async (id: string) => {
    const found = (await detail()).pending.find((pending) => pending.id === id);
    if (found === undefined) throw new Error('no such pending install ' + id);
    return found;
  };

  beforeEach(async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 3).toString('base64'));
    failBeforeLink = false;
    registerOptions = undefined;
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    // The new app's name is asked of Feishu once it exists (the Apps page shows it).
    const channelFetch: typeof fetch = async (input) => String(input).endsWith('/bot/v3/info')
      ? Response.json({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Juno Bot' } })
      : Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    app = createTestApp({ store, bus: mem.eventBus, enqueuer: new RecordingEnqueuer(), feishuRegisterApp: fakeRegister, channelFetch });
    await store.put('agents', makeAgent('agent-1'));
    return () => { vi.unstubAllEnvs(); };
  });

  it('returns the verification link and no code, then writes the sealed row and binds the approver', async () => {
    const res = await connect({ mode: 'register', domain: 'lark' });
    expect(res.status).toBe(202);
    const body = installAppResponseSchema.parse(await res.json());
    expect(body.openUrl).toContain('user_code=ABCD');
    expect(JSON.stringify(body)).not.toContain('bindCode');
    expect(registerOptions?.domain).toBe('accounts.larksuite.com');
    const id = body.pending?.id ?? '';
    expect((await poll(id)).status).toBe('pending');

    finishFlow({ client_id: 'cli_new', client_secret: 'shh', user_info: { open_id: 'ou_owner', tenant_brand: 'lark' } });
    await vi.waitFor(async () => { expect((await poll(id)).status).toBe('connected'); });
    const row = await store.get('channels', 'feishu:cli_new');
    expect(decryptSecret(row?.botToken ?? '')).toBe('shh');
    expect(row).toMatchObject({ agentId: 'agent-1', domain: 'lark', ownerExternalId: 'ou_owner' });
    expect((await detail()).installations).toMatchObject([{ id: 'feishu:cli_new', label: 'Juno Bot', bound: true, agentId: 'agent-1' }]);
  });

  it('leaves the owner unbound (app confirmation) when the SDK does not name the approver and no email is known', async () => {
    const body = installAppResponseSchema.parse(await (await connect({ mode: 'register' })).json());
    finishFlow({ client_id: 'cli_two', client_secret: 'shh2' });
    await vi.waitFor(async () => { expect((await poll(body.pending?.id ?? '')).status).toBe('connected'); });
    const row = await store.get('channels', 'feishu:cli_two');
    expect(row?.ownerExternalId).toBeUndefined();
    expect(row?.domain).toBe('feishu');
  });

  it('looks the approver up by the owner email when the SDK does not name them', async () => {
    const lookups: string[] = [];
    const channelFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      lookups.push(url);
      if (url.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
      return Response.json({ code: 0, data: { user_list: [{ email: JSON.parse(String(init?.body)).emails[0], user_id: 'ou_by_email' }] } });
    };
    const out = await feishuConnector.connect({ deps: { store, channelFetch, feishuRegisterApp: fakeRegister } as unknown as AgentdDeps, ownerId: OWNER, agentId: 'agent-1', ownerEmail: 'me@example.com', body: { mode: 'register' } });
    if (!out.ok || !('pending' in out)) throw new Error('register failed');
    finishFlow({ client_id: 'cli_mail', client_secret: 'shh3' });
    await vi.waitFor(async () => { expect(await store.get('channels', 'feishu:cli_mail')).not.toBeNull(); });
    expect((await store.get('channels', 'feishu:cli_mail'))?.ownerExternalId).toBe('ou_by_email');
    expect(lookups.some((url) => url.includes('batch_get_id'))).toBe(true);
  });

  it('reports a refusal and an expiry, and 502s when Feishu cannot start', async () => {
    const denied = installAppResponseSchema.parse(await (await connect({ mode: 'register' })).json());
    failFlow(new Error('access_denied'));
    await vi.waitFor(async () => { expect((await poll(denied.pending?.id ?? '')).status).toBe('failed'); });
    expect((await poll(denied.pending?.id ?? '')).error).toBe('access_denied');
    expect(await store.get('channels', 'feishu:cli_new')).toBeNull();

    const slow = installAppResponseSchema.parse(await (await connect({ mode: 'register' })).json());
    const stored = await store.get('channels', 'pending:' + (slow.pending?.id ?? ''));
    await store.put('channels', { ...(stored as ChannelRow), pending: { ...(stored?.pending as NonNullable<ChannelRow['pending']>), expiresAt: '2020-01-01T00:00:00.000Z' } });
    expect((await poll(slow.pending?.id ?? '')).status).toBe('expired');
    finishFlow({ client_id: 'cli_late', client_secret: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.get('channels', 'feishu:cli_late')).toBeNull();

    failBeforeLink = true;
    expect((await connect({ mode: 'register' })).status).toBe(502);
  });
});
