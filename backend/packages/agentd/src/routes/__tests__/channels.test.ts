/**
 * CH1 agentd ingress: one accepted platform event becomes exactly one wake. The conversation id is
 * derived deterministically from the platform identity, so a redelivery lands in the same thread;
 * the speaker role is decided at ingress and written into the wake (trusted).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { createMemoryStore, createStore, type DbStore } from '@agent-desktop/db';
import { startScratchPostgres, type ScratchPostgres } from '@agent-desktop/db/testing/scratch-postgres';
import type { Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import type { Agent } from '@agent-desktop/public-contracts';
import type { ChannelRow } from '@agent-desktop/contracts';
import { createIdentity, type Identity } from '@agent-desktop/memory-graph/identity';
import { rowId } from 'juno-agent/modules/home/mirror';
import { BACKFILL_MARKER, backfillPeople } from '../../channels/people.js';
import { createTestApp, ownerHeaders, testChannels, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import { admitChannelEvent } from '../channels.js';

const OWNER = getConfig().OWNER_ID;
const AT = '2026-10-06T00:00:00.000Z';

function makeAgent(id: string): Agent {
  return {
    id,
    name: 'Agent ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'Test agent',
    status: 'idle',
    section: 'Inbox',
    pinned: false,
    lastActivity: 'Just created',
    unreadCount: 0,
    model: {
      planner: { provider: 'openai', model: 'gpt-4' },
      computer: { provider: 'openai', model: 'gpt-4-vision' },
      fast: { provider: 'openai', model: 'gpt-3.5-turbo' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: OWNER,
    createdAt: AT,
    updatedAt: AT,
  };
}

function makeChannel(id: string, agentId: string, extra: { ownerExternalId?: string } = {}): ChannelRow {
  const [kind, channelId] = id.split(':');
  if (kind === undefined || channelId === undefined) throw new Error('bad channel id ' + id);
  return {
    id,
    ownerId: OWNER,
    agentId,
    kind,
    channelId,
    secretHashHex: createHash('sha256').update('platform-secret').digest('hex'),
    createdAt: AT,
    updatedAt: AT,
    ...extra,
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

function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method: 'POST',
    headers: { ...ownerHeaders(OWNER), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('channel ingress', () => {
  let store: Store;
  let app: Hono;
  let enqueuer: RecordingEnqueuer;

  async function call(path: string, body: unknown): Promise<Response> {
    return post(app, path, body);
  }

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    await store.put('agents', makeAgent('agent-1'));
    await store.put('channels', makeChannel('telegram:bot-1', 'agent-1', { ownerExternalId: 'user-7' }));
  });

  it('admits a private message as one trusted user_message wake in a deterministic conversation', async () => {
    const event = { chatType: 'private', threadId: 'dm-7', chatId: 'chat-7', text: 'hello', externalMessageId: 'm-1', from: { id: 'user-7' } };
    const first = await call('/v1/channels/telegram/bot-1/events', event);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { conversationId: string };
    const retry = await call('/v1/channels/telegram/bot-1/events', event);
    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()) as { conversationId: string };
    expect(retryBody.conversationId).toBe(firstBody.conversationId);
    expect(enqueuer.wakes).toHaveLength(2);
    const [wake, replay] = enqueuer.wakes;
    if (!wake || !replay) throw new Error('expected two wakes');
    expect(replay.id).toBe(wake.id);
    expect(wake.kind).toBe('user_message');
    expect(wake.trusted).toBe(true);
    expect(wake.conversationId).toBe(firstBody.conversationId);
    expect(wake.agentId).toBe('agent-1');
    const payload = wake.payload as Record<string, unknown>;
    expect(payload['speakerRole']).toBe('owner');
    expect(payload['externalMessageId']).toBe('m-1');
    const items = await store.list('items', { where: { conversationId: firstBody.conversationId } });
    expect(items.items).toHaveLength(1);
  });

  it('admits a group message as room_mention in a different conversation with a stranger speaker', async () => {
    const group = { chatType: 'group', threadId: 'group-9', chatId: 'chat-9', text: 'hey all', externalMessageId: 'm-9', from: { id: 'user-9' } };
    const res = await call('/v1/channels/telegram/bot-1/events', group);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { conversationId: string };
    expect(enqueuer.wakes).toHaveLength(1);
    const wake = enqueuer.wakes[0];
    if (!wake) throw new Error('expected one wake');
    expect(wake.kind).toBe('room_mention');
    expect(wake.trusted).toBe(false);
    expect((wake.payload as Record<string, unknown>)['speakerRole']).toBe('stranger');
    const direct = await call('/v1/channels/telegram/bot-1/events', {
      chatType: 'private', threadId: 'dm-9', chatId: 'chat-9', text: 'hi', externalMessageId: 'm-10',
    });
    const directBody = (await direct.json()) as { conversationId: string };
    expect(directBody.conversationId).not.toBe(body.conversationId);
  });

  it('decides owner vs stranger from the bound owner platform id', async () => {
    await store.put('channels', makeChannel('telegram:bot-2', 'agent-1', { ownerExternalId: 'user-7' }));
    const own = await call('/v1/channels/telegram/bot-2/events', {
      chatType: 'private', threadId: 'dm-1', text: 'mine', externalMessageId: 'o-1', from: { id: 'user-7' },
    });
    expect(own.status).toBe(202);
    const stranger = await call('/v1/channels/telegram/bot-2/events', {
      chatType: 'private', threadId: 'dm-2', text: 'theirs', externalMessageId: 's-1', from: { id: 'user-9' },
    });
    expect(stranger.status).toBe(202);
    const roles = enqueuer.wakes.map((wake) => (wake.payload as Record<string, unknown>)['speakerRole']);
    expect(roles).toEqual(['owner', 'stranger']);
  });

  it('answers 404 for an unknown channel and 400 for a malformed event', async () => {
    const missing = await call('/v1/channels/telegram/nope/events', { chatType: 'private', text: 'hi' });
    expect(missing.status).toBe(404);
    expect(enqueuer.wakes).toHaveLength(0);
    const malformed = await app.request('/v1/channels/telegram/bot-1/events', {
      method: 'POST',
      headers: { ...ownerHeaders(OWNER), 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(malformed.status).toBe(400);
    const empty = await call('/v1/channels/telegram/bot-1/events', { chatType: 'private', text: '  ' });
    expect(empty.status).toBe(400);
    expect(enqueuer.wakes).toHaveLength(0);
  });
});

describe('channel ingress records who speaks (identity, Postgres)', () => {
  let cluster: ScratchPostgres;
  let store: DbStore;
  let identity: Identity;
  let enqueuer: RecordingEnqueuer;
  let app: Hono;
  type Raw = NonNullable<DbStore['raw']>;

  function raw(): Raw {
    if (store.raw === undefined) throw new Error('the Postgres store has raw SQL');
    return store.raw;
  }

  function scoped(): Store {
    if (store.forOwner === undefined) throw new Error('the Postgres store has owner scopes');
    return store.forOwner(OWNER);
  }

  async function rows<T extends object>(sql: string, params: string[]): Promise<T[]> {
    return raw().query<T>(sql, params);
  }

  async function counts(): Promise<{ people: number; accounts: number }> {
    const [row] = await rows<{ people: string | number; accounts: string | number }>(
      'SELECT (SELECT COUNT(*) FROM people WHERE owner_id = ?) AS people, (SELECT COUNT(*) FROM accounts WHERE owner_id = ?) AS accounts',
      [OWNER, OWNER],
    );
    return { people: Number(row?.people), accounts: Number(row?.accounts) };
  }

  async function accountOf(platform: string, externalId: string): Promise<{ id: string; person_id: string | null; name: string | null } | undefined> {
    const [row] = await rows<{ id: string; person_id: string | null; name: string | null }>(
      'SELECT id, person_id, name FROM accounts WHERE owner_id = ? AND platform = ? AND external_id = ?',
      [OWNER, platform, externalId],
    );
    return row;
  }

  async function picture(): Promise<{ accounts: unknown[]; people: unknown[] }> {
    return {
      accounts: await rows('SELECT id, person_id, name FROM accounts WHERE owner_id = ? ORDER BY id', [OWNER]),
      people: await rows('SELECT id, name, is_owner FROM people WHERE owner_id = ? ORDER BY id', [OWNER]),
    };
  }

  function lastPayload(): Record<string, unknown> {
    const wake = enqueuer.wakes[enqueuer.wakes.length - 1];
    if (wake === undefined) throw new Error('expected a wake');
    return wake.payload as Record<string, unknown>;
  }

  beforeAll(async () => {
    cluster = await startScratchPostgres();
    store = await createStore(cluster.url);
    identity = createIdentity(raw());
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: store.eventBus, enqueuer, identity });
    await scoped().put('agents', makeAgent('agent-1'));
    await scoped().put('channels', makeChannel('telegram:bot-3', 'agent-1', { ownerExternalId: 'user-7' }));
    await scoped().put('channels', makeChannel('discord:bot-4', 'agent-1', { ownerExternalId: 'user-7' }));
  }, 240_000);

  afterAll(async () => {
    await store?.close();
    await cluster?.close();
  });

  it('records a stranger once: an account with a person of its own, and the wake carries that person id', async () => {
    const before = await counts();
    const stranger = { chatType: 'private', threadId: 'dm-bob', chatId: 'chat-bob', text: 'hi', externalMessageId: 'bob-1', from: { id: 'user-9', name: 'Bob' } };
    expect((await post(app, '/v1/channels/telegram/bot-3/events', stranger)).status).toBe(202);
    const account = await accountOf('telegram', 'user-9');
    expect(account).toMatchObject({ name: 'Bob' });
    expect(lastPayload()).toMatchObject({ speakerRole: 'stranger', personId: account?.person_id });
    expect(await rows('SELECT name, is_owner FROM people WHERE id = ?', [account?.person_id ?? ''])).toEqual([{ name: 'Bob', is_owner: false }]);
    const after = await counts();
    expect(after).toEqual({ people: before.people + 1, accounts: before.accounts + 1 });

    // The same sender again: no new rows, the same person.
    expect((await post(app, '/v1/channels/telegram/bot-3/events', { ...stranger, externalMessageId: 'bob-2' })).status).toBe(202);
    expect(await counts()).toEqual(after);
    expect((await accountOf('telegram', 'user-9'))?.person_id).toBe(account?.person_id);
    expect(lastPayload()).toMatchObject({ personId: account?.person_id });
  });

  it('links the owner\'s account to the owner\'s person, and a peer agent\'s message records no account', async () => {
    const mine = { chatType: 'private', threadId: 'dm-7', chatId: 'chat-7', text: 'hello', externalMessageId: 'own-1', from: { id: 'user-7', name: 'Robin' } };
    expect((await post(app, '/v1/channels/telegram/bot-3/events', mine)).status).toBe(202);
    const [owner] = await rows<{ id: string }>('SELECT id FROM people WHERE owner_id = ? AND is_owner', [OWNER]);
    expect(owner).toBeDefined();
    expect(await accountOf('telegram', 'user-7')).toMatchObject({ person_id: owner?.id, name: 'Robin' });
    expect(lastPayload()).toMatchObject({ speakerRole: 'owner', personId: owner?.id });

    // Another of the owner's agents speaking in the Discord channel: admitted as an agent's message, and no account is recorded for it.
    const accountsBefore = (await counts()).accounts;
    const peer = await admitChannelEvent(
      { store: scoped(), enqueuer, channels: testChannels, identity },
      OWNER,
      'discord',
      'bot-4',
      { chatType: 'private', threadId: 'dm-a', text: 'hi from Atlas', externalMessageId: 'peer-1', from: { id: 'agent:agent-1', name: 'Atlas' } },
      { agentId: 'agent-1', hop: { chainId: 'chain-1', depth: 1 } },
    );
    expect(peer.status).toBe(202);
    expect(lastPayload()).toMatchObject({ speakerRole: 'agent' });
    expect(lastPayload()['personId']).toBeUndefined();
    expect(await accountOf('discord', 'agent:agent-1')).toBeUndefined();
    expect((await counts()).accounts).toBe(accountsBefore);
  });

  it('records a group sender as an account only, until the message addresses the agent', async () => {
    const group = { chatType: 'group', threadId: 'g-q', chatId: 'chat-q', text: 'hello all', externalMessageId: 'grp-1', from: { id: 'user-11', name: 'Quiet' } };
    const before = await counts();
    expect((await post(app, '/v1/channels/telegram/bot-3/events', group)).status).toBe(202);
    expect(await accountOf('telegram', 'user-11')).toMatchObject({ name: 'Quiet', person_id: null });
    expect(lastPayload()['personId']).toBeUndefined();
    expect(await counts()).toEqual({ people: before.people, accounts: before.accounts + 1 });

    // Addressed: a mention of this Telegram bot (its username is the channel id). The same account now gets a person.
    const addressed = { ...group, externalMessageId: 'grp-2', text: '@bot-3 you there?', mentions: [{ id: 'tg-bot-3', name: 'Nova', handle: 'bot-3' }] };
    expect((await post(app, '/v1/channels/telegram/bot-3/events', addressed)).status).toBe(202);
    const account = await accountOf('telegram', 'user-11');
    expect(account?.person_id).not.toBeNull();
    expect(lastPayload()).toMatchObject({ personId: account?.person_id });
    expect(await counts()).toEqual({ people: before.people + 1, accounts: before.accounts + 1 });
  });

  it('backfills once: bound owner accounts are linked, stored senders become accounts, and a rerun changes nothing', async () => {
    await scoped().put('items', {
      id: 'itm-carol-1', conversationId: 'cvn-carol', type: 'user_message', authorId: 'ext-carol', text: 'hi', attachments: [], mentions: [], at: AT,
      channelSender: { kind: 'telegram', externalId: '555', name: 'Carol', role: 'stranger' },
      source: { kind: 'telegram', channelId: 'bot-3', chatId: 'chat-5', threadId: 'chat-5', chatType: 'private' },
    }, { conversationId: 'cvn-carol' });

    expect(await backfillPeople({ store, raw: raw(), identity })).toMatchObject({ skipped: false });
    expect(await accountOf('telegram', '555')).toMatchObject({ name: 'Carol' });
    const snapshot = await picture();

    // Without the marker a rerun finds every row there already: nothing moves.
    await store.delete('agentHome', rowId('system', BACKFILL_MARKER));
    expect(await backfillPeople({ store, raw: raw(), identity })).toMatchObject({ skipped: false });
    expect(await picture()).toEqual(snapshot);

    // With the marker the next boot skips it.
    expect(await backfillPeople({ store, raw: raw(), identity })).toMatchObject({ skipped: true });
  });
});
