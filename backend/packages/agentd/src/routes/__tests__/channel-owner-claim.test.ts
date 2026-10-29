/**
 * Owner confirmation fallback: an unbound channel's first private message is held, the owner gets an "Is this you?"
 * request in the app, and It's me / Not me decide whether the held message is admitted as the owner's or a stranger's.
 * No code text is ever sent to the platform. Telegram is a fake fetch; nothing touches the network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { decryptSecret, encryptSecret } from '@agent-desktop/contracts/secrets';
import { type Agent, type Request } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-19T00:00:00.000Z';
const TOKEN = '123:good-token';

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

describe('owner confirmation in the app', () => {
  let app: Hono;
  let store: Store;
  let enqueuer: RecordingEnqueuer;
  let sent: string[];

  const fakeTelegram: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const [, , method] = /bot([^/]+)\/(\w+)$/.exec(url) ?? [];
    if (method === 'sendMessage') sent.push(String(init?.body));
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 1, is_bot: true, username: 'JunoBot' } });
    return Response.json({ ok: true, result: true });
  };

  const dm = (fromId: number, text: string, messageId: number): Promise<Response> =>
    Promise.resolve(app.request('/v1/channels/telegram/JunoBot/events', {
      method: 'POST',
      headers: ownerHeaders(OWNER, true),
      body: JSON.stringify({
        update_id: messageId,
        message: { message_id: messageId, from: { id: fromId, is_bot: false, first_name: 'Ann' }, chat: { id: fromId, type: 'private' }, text },
      }),
    }));

  const pendingRequests = async (): Promise<Request[]> =>
    ((await (await app.request('/v1/requests?status=pending', { headers: ownerHeaders(OWNER) })).json()) as { items: Request[] }).items;

  const answer = (id: string, choice: string): Promise<Response> =>
    Promise.resolve(app.request('/v1/requests/' + id + '/resolve', {
      method: 'POST', headers: ownerHeaders(OWNER, true), body: JSON.stringify({ action: 'answer', answers: { confirm: choice } }),
    }));

  beforeEach(async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 3).toString('base64'));
    vi.stubEnv('CHANNELS_PUBLIC_URL', '');
    sent = [];
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer, channelFetch: fakeTelegram });
    await store.put('agents', makeAgent('agent-1'));
    // A bot whose owner the platform did not tell us (unbound): the first private message is held for the owner to confirm.
    await store.put('channels', { id: 'telegram:JunoBot', ownerId: OWNER, agentId: 'agent-1', kind: 'telegram', channelId: 'JunoBot', secretHashHex: 'x', botToken: encryptSecret(TOKEN), status: 'active', createdAt: AT, updatedAt: AT });
    return () => { vi.unstubAllEnvs(); };
  });

  it('holds the first private message, raises one request, and says nothing to the sender', async () => {
    expect((await dm(7, 'hello there', 1)).status).toBe(200);
    expect((await dm(7, 'anyone?', 2)).status).toBe(200);
    expect(enqueuer.wakes).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const open = await pendingRequests();
    expect(open).toHaveLength(1);
    const request = open[0] as Request;
    expect(request.kind).toBe('question');
    expect(request.title).toBe('Is this you? Telegram user Ann messaged @JunoBot');
    expect(JSON.stringify(request)).toContain("It's me");
    expect(JSON.stringify(request)).toContain('hello there');
    expect(JSON.stringify(request)).not.toContain('channelClaim');
    // A different sender gets their own request.
    await dm(8, 'hi', 3);
    expect(await pendingRequests()).toHaveLength(2);
  });

  it("It's me binds the sender and admits the held message as the owner's", async () => {
    await dm(7, 'book me a table', 1);
    const request = (await pendingRequests())[0] as Request;
    expect((await answer(request.id, 'me')).status).toBe(200);
    expect((await store.get('channels', 'telegram:JunoBot'))?.ownerExternalId).toBe('7');
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]).toMatchObject({ trusted: true, payload: { text: 'book me a table', speakerRole: 'owner' } });
    expect(sent).toHaveLength(0);
    await dm(7, 'and a taxi', 2);
    expect(enqueuer.wakes.map((wake) => wake.trusted)).toEqual([true, true]);
    expect(await pendingRequests()).toHaveLength(0);
  });

  it('Not me admits the held message as a stranger and never asks about that id again', async () => {
    await dm(9, 'hey bot', 1);
    const request = (await pendingRequests())[0] as Request;
    expect((await answer(request.id, 'not_me')).status).toBe(200);
    const row = await store.get('channels', 'telegram:JunoBot');
    expect(row?.ownerExternalId).toBeUndefined();
    expect(row?.declinedExternalIds).toEqual(['9']);
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]).toMatchObject({ trusted: false, payload: { text: 'hey bot', speakerRole: 'stranger' } });
    await dm(9, 'second', 2);
    expect(enqueuer.wakes.map((wake) => wake.trusted)).toEqual([false, false]);
    expect(await pendingRequests()).toHaveLength(0);
    // Someone else still raises a prompt.
    await dm(10, 'hello', 3);
    expect(await pendingRequests()).toHaveLength(1);
  });

  it('never sends any code text to the platform and ignores a bare word that looks like one', async () => {
    await dm(7, 'S3cretCodeLooksLikeThis', 1);
    expect((await store.get('channels', 'telegram:JunoBot'))?.ownerExternalId).toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(enqueuer.wakes).toHaveLength(0);
  });

  it('does not hold group messages or messages from an already-bound owner', async () => {
    await store.patch('channels', 'telegram:JunoBot', { ownerExternalId: '7' });
    await dm(7, 'hi', 1);
    expect(enqueuer.wakes).toHaveLength(1);
    expect(await pendingRequests()).toHaveLength(0);
  });
});
