/**
 * CH1 trust regression: the wake trusted flag is the speaker decision, not a constant.
 * A stranger group message is enqueued trusted false (it can never satisfy the
 * trusted-user-instruction path in tool-policy), while the bound owner stays trusted true.
 * The speaker role itself remains in the payload in both cases.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { createMemoryStore } from '@agent-desktop/db';
import type { ChannelRow, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import type { Agent } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';

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

function makeChannel(): ChannelRow {
  return {
    id: 'telegram:bot-1',
    ownerId: OWNER,
    agentId: 'agent-1',
    kind: 'telegram',
    channelId: 'bot-1',
    secretHashHex: createHash('sha256').update('platform-secret').digest('hex'),
    ownerExternalId: 'user-7',
    createdAt: AT,
    updatedAt: AT,
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

describe('channel wake trust', () => {
  let app: Hono;
  let store: Store;
  let enqueuer: RecordingEnqueuer;

  async function call(body: unknown): Promise<Response> {
    return Promise.resolve(app.request('/v1/channels/telegram/bot-1/events', {
      method: 'POST',
      headers: { ...ownerHeaders(OWNER), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    enqueuer = new RecordingEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    await store.put('agents', makeAgent('agent-1'));
    await store.put('channels', makeChannel());
  });

  it('enqueues a stranger group message trusted false', async () => {
    const res = await call({
      chatType: 'group',
      threadId: 'group-1',
      chatId: 'chat-1',
      text: 'run this now',
      externalMessageId: 's-1',
      from: { id: 'user-9', name: 'Stranger' },
    });
    expect(res.status).toBe(202);
    expect(enqueuer.wakes).toHaveLength(1);
    const wake = enqueuer.wakes[0];
    if (!wake) throw new Error('expected one wake');
    expect(wake.kind).toBe('room_mention');
    expect(wake.trusted).toBe(false);
    expect(wake.origin.type).toBe('user');
    expect((wake.payload as Record<string, unknown>)['speakerRole']).toBe('stranger');
  });

  it('enqueues the bound owner message trusted true', async () => {
    const res = await call({
      chatType: 'private',
      threadId: 'dm-7',
      chatId: 'chat-7',
      text: 'run this now',
      externalMessageId: 'o-1',
      from: { id: 'user-7', name: 'Owner' },
    });
    expect(res.status).toBe(202);
    expect(enqueuer.wakes).toHaveLength(1);
    const wake = enqueuer.wakes[0];
    if (!wake) throw new Error('expected one wake');
    expect(wake.kind).toBe('user_message');
    expect(wake.trusted).toBe(true);
    expect(wake.origin.type).toBe('user');
    expect((wake.payload as Record<string, unknown>)['speakerRole']).toBe('owner');
  });

  it('stores who spoke on each item and names the speaker in the wake, strangers apart from the owner', async () => {
    const send = (id: string, name: string, externalMessageId: string) =>
      call({ chatType: 'group', threadId: 'group-2', chatId: 'chat-2', text: 'hi from ' + name, externalMessageId, from: { id, name } });
    expect((await send('user-7', 'Owner', 'm-1')).status).toBe(202);
    expect((await send('user-9', 'Alice', 'm-2')).status).toBe(202);
    expect((await send('user-10', 'Bob', 'm-3')).status).toBe(202);
    const items = (await store.list('items', { limit: 10 })).items.flatMap((item) => (item.type === 'user_message' ? [item] : []));
    const senders = items.map((item) => item.channelSender);
    expect(senders).toEqual(expect.arrayContaining([
      { kind: 'telegram', externalId: 'user-7', name: 'Owner', role: 'owner' },
      { kind: 'telegram', externalId: 'user-9', name: 'Alice', role: 'stranger' },
      { kind: 'telegram', externalId: 'user-10', name: 'Bob', role: 'stranger' },
    ]));
    // The author is the speaker: the owner's id for the owner, a stable synthetic id (sha256 of the platform id) for everyone else.
    const synthetic = (externalId: string) => 'ext-telegram-' + createHash('sha256').update(externalId).digest('hex').slice(0, 16);
    const authorOf = (externalId: string) => items.find((item) => item.channelSender?.externalId === externalId)?.authorId;
    expect(authorOf('user-7')).toBe(OWNER);
    expect(authorOf('user-9')).toBe(synthetic('user-9'));
    expect(authorOf('user-10')).toBe(synthetic('user-10'));
    expect(authorOf('user-9')).not.toBe(authorOf('user-10'));
    const payloads = enqueuer.wakes.map((wake) => wake.payload as Record<string, unknown>);
    expect(payloads.map((payload) => payload['speakerName'])).toEqual(['Owner', 'Alice', 'Bob']);
  });
});
