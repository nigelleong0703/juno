/**
 * The outbox sender (BACKEND 5.7.11), offline: a fake platform and a fake clock drive the real sender, intake and routes over the in-memory store.
 * What matters here: order inside a conversation, retry and give-up, what the agent is told, what a freeze stops, and that a restart loses nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import type { Conversation, Item, OutboxList } from '@agent-desktop/public-contracts';
import type { OutboxRow } from 'juno-agent/contracts';
import { createTestApp, requestAs, testChannels, withDefaultOwner } from '../../__tests__/test-app.js';
import type { ChannelSender, ChannelSenders } from '../../channels/delivery.js';
import { createSeen, ingestItem, scanItems } from '../intake.js';
import { startOutboxSender, type OutboxSender } from '../sender.js';

const OWNER = 'owner-1';
const AT = Date.parse('2026-11-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

type FakeSend = Awaited<ReturnType<ChannelSender['sendText']>>;

interface Harness {
  store: Store;
  sender: OutboxSender;
  sent: string[];
  wakes: WakeEvent[];
  /** What the platform answers next, per call; once empty it succeeds. */
  answers: FakeSend[];
  /** The platform plugin is off. */
  off: { value: boolean };
  clock: { now: number };
  env: Record<string, string>;
}

const conversation = (id: string, chatId: string, extra: Record<string, unknown> = {}): Conversation => ({
  id, kind: 'direct', agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: iso(AT), createdAt: iso(AT), ownerId: OWNER,
  channel: { kind: 'telegram', channelId: 'bot-1', threadId: chatId, chatId }, ...extra,
} as unknown as Conversation);

const reply = (id: string, conversationId: string, text: string, at: number, runId = 'run-1'): Item =>
  ({ id, ownerId: OWNER, conversationId, type: 'agent_message', agentId: 'agent-1', runId, markdown: text, citations: [], at: iso(at) } as Item);

async function harness(): Promise<Harness> {
  const store = createMemoryStore();
  const wakes: WakeEvent[] = [];
  const sent: string[] = [];
  const answers: FakeSend[] = [];
  const off = { value: false };
  // A minute ahead of the real clock, which stamps a new row's first try (a row is due the moment it is made).
  const clock = { now: Date.now() + 60_000 };
  const env: Record<string, string> = {};
  await store.put('channels', { id: 'telegram:bot-1', ownerId: OWNER, agentId: 'agent-1', kind: 'telegram', channelId: 'bot-1', secretHashHex: 'h', botToken: 'tok', createdAt: iso(AT), updatedAt: iso(AT) } as never);
  await store.put('conversations', conversation('cvn-1', 'chat-1'));
  await store.put('conversations', conversation('cvn-2', 'chat-2'));
  const telegram: ChannelSender = { sendText: async (target, text) => { sent.push(target.chatId + ': ' + text); return answers.shift() ?? { ok: true, externalId: 'm' + String(sent.length) }; } };
  const senders: ChannelSenders = (kind) => (kind === 'telegram' && !off.value ? telegram : undefined);
  const enqueuer = { enqueue: async (event: WakeEvent) => { wakes.push(event); return { accepted: true }; } } as unknown as Enqueuer;
  const sender = startOutboxSender({ store, senders, channels: testChannels, blobs: createMemoryBlobStore(), enqueuer, env, now: () => clock.now, sleep: async () => undefined, manual: true });
  return { store, sender, sent, wakes, answers, off, clock, env };
}

const rowOf = async (store: Store, itemId: string): Promise<OutboxRow> => {
  const row = await store.get('outbox', 'obx:reply:' + itemId);
  if (row === null) throw new Error('no outbox row for ' + itemId);
  return row;
};

const transient: FakeSend = { ok: false, error: 'Telegram send failed: 503 upstream', failure: { kind: 'transient' } };

describe('the outbox sender', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it('retries a transient failure with backoff and keeps the conversation in order: the next message waits behind it, then goes', async () => {
    await h.store.put('items', reply('a', 'cvn-1', 'first', AT));
    await h.store.put('items', reply('b', 'cvn-1', 'second', AT + 1000));
    await h.store.put('items', reply('c', 'cvn-2', 'other chat', AT + 500));
    expect(await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' })).toBe(true);
    await ingestItem(h.store, { id: 'b', type: 'agent_message', conversationId: 'cvn-1' });
    await ingestItem(h.store, { id: 'c', type: 'agent_message', conversationId: 'cvn-2' });
    h.answers.push(transient);

    // Try 1: `first` fails; `second` is held behind it, while the other conversation is not.
    await h.sender.tick();
    expect(h.sent).toEqual(['chat-1: first', 'chat-2: other chat']);
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'pending', attempts: 1, lastError: expect.stringContaining('503') });
    // Not due yet (5 s): nothing moves.
    h.clock.now += 4_000;
    await h.sender.tick();
    expect(h.sent).toHaveLength(2);
    // Try 2 at 5 s fails again, the next is due 10 s later; try 3 succeeds and `second` follows in the same pass.
    h.answers.push(transient);
    h.clock.now += 1_000;
    await h.sender.tick();
    expect(await rowOf(h.store, 'a')).toMatchObject({ attempts: 2 });
    h.clock.now += 10_000;
    await h.sender.tick();
    expect(h.sent).toEqual(['chat-1: first', 'chat-2: other chat', 'chat-1: first', 'chat-1: first', 'chat-1: second']);
    expect(await rowOf(h.store, 'c')).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'sent', attempts: 3 });
    expect(await rowOf(h.store, 'b')).toMatchObject({ status: 'sent', attempts: 1 });
    // Sent rows are never sent again.
    h.clock.now += 60_000;
    await h.sender.tick();
    expect(h.sent).toHaveLength(5);
  });

  it('honours the platform\'s own wait when it is longer than the backoff', async () => {
    await h.store.put('items', reply('a', 'cvn-1', 'hello', AT));
    await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' });
    h.answers.push({ ok: false, error: 'Telegram send failed: 429', failure: { kind: 'transient', retryAfterMs: 60_000 } });
    await h.sender.tick();
    h.clock.now += 30_000;
    await h.sender.tick();
    expect(h.sent).toHaveLength(1);
    h.clock.now += 31_000;
    await h.sender.tick();
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('gives up after eight transient failures, turns the channel red, and tells the agent once', async () => {
    await h.store.put('items', reply('a', 'cvn-1', 'hello', AT));
    await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' });
    for (let i = 0; i < 8; i += 1) {
      h.answers.push(transient);
      await h.sender.tick();
      h.clock.now += 5 * 60_000 + 1;
    }
    await h.sender.tick();
    expect(h.sent).toHaveLength(8);
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'dropped', droppedReason: 'retries_exhausted', attempts: 8, agentNotified: true });
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]).toMatchObject({ id: 'delivery-failed:obx:reply:a', conversationId: 'cvn-1', agentId: 'agent-1', kind: 'hand_back', trusted: true, origin: { type: 'system' } });
    expect(String(h.wakes[0]?.payload['text'])).toMatch(/^\[delivery failed\] Your message in the Telegram private chat was not delivered: .*It will not arrive; do not claim it was sent\.$/);
    expect(h.sender.health(OWNER)).toMatchObject({ status: 'red', failing: [{ platform: 'telegram', channelId: 'bot-1', consecutiveFailures: 8 }] });
    expect(h.sender.health('someone-else')).toEqual({ status: 'ok', failing: [] });
  });

  it('drops a permanent failure at once without blocking what is behind it; a refused credential also marks the channel', async () => {
    await h.store.put('items', reply('a', 'cvn-1', 'first', AT));
    await h.store.put('items', reply('b', 'cvn-1', 'second', AT + 1000));
    await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' });
    await ingestItem(h.store, { id: 'b', type: 'agent_message', conversationId: 'cvn-1' });
    h.answers.push({ ok: false, error: 'Forbidden: bot was kicked from the group chat', failure: { kind: 'channel_gone' } });
    await h.sender.tick();
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'dropped', droppedReason: 'channel_gone', attempts: 1 });
    expect(await rowOf(h.store, 'b')).toMatchObject({ status: 'sent' });
    expect(h.wakes).toHaveLength(1);

    await h.store.put('items', reply('c', 'cvn-1', 'third', AT + 2000));
    await ingestItem(h.store, { id: 'c', type: 'agent_message', conversationId: 'cvn-1' });
    h.answers.push({ ok: false, error: 'Unauthorized', failure: { kind: 'token_invalid' } });
    await h.sender.tick();
    expect(await rowOf(h.store, 'c')).toMatchObject({ status: 'dropped', droppedReason: 'token_invalid' });
    expect((await h.store.get('channels', 'telegram:bot-1'))?.status).toBe('invalid_token');
    expect(h.wakes.map((wake) => wake.id)).toEqual(['delivery-failed:obx:reply:a', 'delivery-failed:obx:reply:c']);
  });

  it('does not wake the agent about a reply it wrote in answer to a delivery-failed note (no loop)', async () => {
    await h.store.put('runs', { id: 'run-note', agentId: 'agent-1', conversationId: 'cvn-1', origin: { type: 'system', wakeKind: 'hand_back', label: 'delivery failed' } } as never);
    await h.store.put('items', reply('a', 'cvn-1', 'telling you', AT, 'run-note'));
    await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' });
    h.answers.push({ ok: false, error: 'chat not found', failure: { kind: 'channel_gone' } });
    await h.sender.tick();
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'dropped', agentNotified: true });
    expect(h.wakes).toHaveLength(0);
  });

  it('waits while the platform plugin is off (nothing counted, nothing dropped) and sends when it is back', async () => {
    await h.store.put('items', reply('a', 'cvn-1', 'hello', AT));
    await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' });
    h.off.value = true;
    for (let i = 0; i < 3; i += 1) { await h.sender.tick(); h.clock.now += 31_000; }
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'pending', attempts: 0, lastError: expect.stringContaining('plugin is disabled') });
    expect(h.wakes).toHaveLength(0);
    h.off.value = false;
    await h.sender.tick();
    expect(h.sent).toEqual(['chat-1: hello']);
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'sent' });
  });

  it('a freeze (the owner\'s or the operator\'s) sends nothing, and unfreezing sends in order', async () => {
    await h.store.put('items', reply('a', 'cvn-1', 'first', AT));
    await h.store.put('items', reply('b', 'cvn-1', 'second', AT + 1000));
    await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' });
    await ingestItem(h.store, { id: 'b', type: 'agent_message', conversationId: 'cvn-1' });
    await h.store.put('outboxControl', { id: OWNER, ownerId: OWNER, frozen: true, updatedAt: iso(AT) });
    await h.sender.tick();
    expect(h.sent).toEqual([]);
    await h.store.put('outboxControl', { id: OWNER, ownerId: OWNER, frozen: false, updatedAt: iso(AT) });
    h.env['OUTBOX_FROZEN'] = '1';
    await h.sender.tick();
    expect(h.sent).toEqual([]);
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'pending', attempts: 0 });
    delete h.env['OUTBOX_FROZEN'];
    await h.sender.tick();
    expect(h.sent).toEqual(['chat-1: first', 'chat-1: second']);
  });
});

describe('how rows are made', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it('makes a row once per source however often it is offered', async () => {
    await h.store.put('items', reply('a', 'cvn-1', 'a reply', AT), { conversationId: 'cvn-1' });
    expect(await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' })).toBe(true);
    expect(await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' })).toBe(false);
    await h.sender.tick();
    expect(await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' })).toBe(false);
    expect(h.sent).toEqual(['chat-1: a reply']);
  });

  it('leaves out what stays in the app: a chat with no platform, and a quiet group\'s unaddressed reply', async () => {
    const { channel: _channel, ...appChat } = conversation('cvn-app', 'x') as unknown as Record<string, unknown>;
    await h.store.put('conversations', appChat as unknown as Conversation);
    await h.store.put('conversations', conversation('cvn-quiet', 'chat-q', { externalGroup: true }));
    await h.store.put('items', reply('app', 'cvn-app', 'in the app', AT));
    await h.store.put('items', reply('quiet', 'cvn-quiet', 'not addressed', AT));
    expect(await ingestItem(h.store, { id: 'app', type: 'agent_message', conversationId: 'cvn-app' })).toBe(false);
    expect(await ingestItem(h.store, { id: 'quiet', type: 'agent_message', conversationId: 'cvn-quiet' })).toBe(false);
  });

  it('a restart between the item being stored and its send loses nothing: the catch-up scan finds it, and what was sent before is not sent again', async () => {
    await h.store.put('items', reply('sent-before', 'cvn-1', 'already out', AT - 60_000));
    await ingestItem(h.store, { id: 'sent-before', type: 'agent_message', conversationId: 'cvn-1' });
    await h.sender.tick();
    await h.store.put('items', reply('lost', 'cvn-1', 'stored, never queued', AT));
    // A new process: nothing in memory, the store is all there is.
    const restarted = await scanItems(h.store, AT - 24 * 60 * 60_000, createSeen());
    expect(restarted).toBe(1);
    await h.sender.tick();
    expect(h.sent).toEqual(['chat-1: already out', 'chat-1: stored, never queued']);
  });

  it('a send interrupted by a crash (the attempt mark is on, no result) is tried again, in order', async () => {
    await h.store.put('items', reply('a', 'cvn-1', 'maybe sent', AT));
    await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' });
    const row = await rowOf(h.store, 'a');
    await h.store.put('outbox', { ...row, attempts: 1, attemptingAt: iso(AT) });
    await h.sender.tick();
    expect(h.sent).toEqual(['chat-1: maybe sent']);
    expect(await rowOf(h.store, 'a')).toMatchObject({ status: 'sent', attempts: 2 });
    expect((await rowOf(h.store, 'a')).attemptingAt).toBeUndefined();
  });
});

describe('the owner\'s outbox over HTTP', () => {
  let app: Hono;
  let h: Harness;
  const call = (path: string, method = 'GET', body?: unknown, who = OWNER) => requestAs(app, who, path, { method, body });
  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

  beforeEach(async () => {
    h = await harness();
    const mem = h.store as ReturnType<typeof createMemoryStore>;
    app = createTestApp({ store: withDefaultOwner(mem, OWNER), bus: mem.eventBus, outbox: h.sender, enqueuer: { enqueue: async () => ({ accepted: true }), stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {} } });
    await h.store.put('items', reply('a', 'cvn-1', 'first', AT));
    await h.store.put('items', reply('b', 'cvn-1', 'second', AT + 1000));
    await ingestItem(h.store, { id: 'a', type: 'agent_message', conversationId: 'cvn-1' });
    await ingestItem(h.store, { id: 'b', type: 'agent_message', conversationId: 'cvn-1' });
    h.answers.push({ ok: false, error: 'chat not found', failure: { kind: 'channel_gone' } });
    await h.sender.tick();
  });

  it('lists what was dropped (keyset paged, no message text), puts it back once, and shows the state under the bubble', async () => {
    const dropped = await json<OutboxList>(await call('/v1/outbox?status=dropped&conversationId=cvn-1'));
    expect(dropped.items).toMatchObject([{ id: 'obx:reply:a', status: 'dropped', reason: 'channel_gone', kind: 'channel_reply', platform: 'telegram', attempts: 1 }]);
    expect(JSON.stringify(dropped)).not.toMatch(/first|second|tok/);
    expect((await json<OutboxList>(await call('/v1/outbox?status=pending'))).items).toEqual([]);
    expect((await json<OutboxList>(await call('/v1/outbox?limit=1'))).nextCursor).toBeUndefined();

    const items = await json<{ items: Array<{ id: string; delivery?: unknown }> }>(await call('/v1/conversations/cvn-1/items'));
    expect(items.items.map((item) => [item.id, item.delivery])).toEqual([['a', { status: 'dropped', reason: 'channel_gone' }], ['b', { status: 'sent' }]]);

    expect((await call('/v1/outbox/obx:reply:b/retry', 'POST')).status).toBe(409);
    expect((await call('/v1/outbox/obx:reply:a/retry', 'POST', undefined, 'owner-other')).status).toBe(404);
    expect((await call('/v1/outbox/obx:reply:a/retry', 'POST')).status).toBe(200);
    expect((await json<OutboxList>(await call('/v1/outbox?status=pending'))).items).toMatchObject([{ id: 'obx:reply:a', attempts: 0 }]);
    await h.sender.tick();
    expect(h.sent).toEqual(['chat-1: first', 'chat-1: second', 'chat-1: first']);
    // It is not told to the agent a second time if it were to drop again: one note per delivery.
    expect(h.wakes).toHaveLength(1);
  });

  it('freezes and unfreezes for the owner, shown in the list, and refuses another owner\'s rows', async () => {
    expect(await json(await call('/v1/outbox/freeze', 'POST', { frozen: true }))).toEqual({ frozen: true });
    expect((await json<OutboxList>(await call('/v1/outbox'))).frozen).toEqual({ owner: true, operator: false });
    expect((await json<OutboxList>(await call('/v1/outbox', 'GET', undefined, 'owner-other'))).frozen).toEqual({ owner: false, operator: false });
    expect((await call('/v1/outbox/freeze', 'POST', { frozen: 'yes' })).status).toBe(400);
    expect((await json<OutboxList>(await call('/v1/outbox', 'GET', undefined, 'owner-other'))).items).toEqual([]);
    expect(await json(await call('/v1/outbox/freeze', 'POST', { frozen: false }))).toEqual({ frozen: false });
  });
});
