import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { EventBus, StoredEvent } from '@agent-desktop/contracts';
import type { AgentEvent, Conversation, Item } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from './test-app.js';

/** A controllable bus: events are pushed by hand and live subscribers are notified synchronously. */
class FakeEventBus implements EventBus {
  readonly events: StoredEvent[] = [];
  released = 0;
  /** Runs once, at the start of the next since() call — used to inject a live event mid-replay. */
  onNextSince?: () => void;
  subscriptionReady?: Promise<void>;
  replayError?: Error;

  private readonly live = new Set<(e: StoredEvent) => void>();

  async since(afterId: number, limit = 100): Promise<StoredEvent[]> {
    if (this.replayError) throw this.replayError;
    const snapshot = [...this.events];
    const hook = this.onNextSince;
    this.onNextSince = undefined;
    if (hook) hook();
    return snapshot
      .filter((e) => e.id > afterId)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
  }

  async prune(): Promise<number> {
    return 0;
  }

  async subscribe(onEvent: (e: StoredEvent) => void): Promise<() => void> {
    this.live.add(onEvent);
    await this.subscriptionReady;
    return () => {
      this.live.delete(onEvent);
      this.released += 1;
    };
  }

  forOwner(): EventBus {
    return this;
  }

  async head(): Promise<number> {
    return Math.max(0, ...this.events.map((e) => e.id));
  }

  store(id: number): StoredEvent {
    const event: AgentEvent = { type: 'agent.status', agentId: 'agt-1', status: 'idle' };
    const stored: StoredEvent = { id, event, at: '2026-10-05T00:00:00.000Z' };
    this.events.push(stored);
    return stored;
  }

  emitLive(id: number): void {
    const stored = this.store(id);
    for (const sub of this.live) sub(stored);
  }
}

function makeApp(bus: EventBus) {
  const store = createMemoryStore();
  return createTestApp({ store, bus, enqueuer: new NoopEnqueuer() });
}

const AUTH = ownerHeaders('owner-1');
const decoder = new TextDecoder();

/** Reads SSE text until `until` matches or the deadline passes, then cancels the stream. */
async function collect(
  response: Response,
  until: (text: string) => boolean,
  timeoutMs = 1000
): Promise<string> {
  const body = response.body;
  if (!body) throw new Error('response has no body');
  const reader = body.getReader();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (!until(text) && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
      ]);
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return text;
}

describe('SSE /v1/events', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips internal request fields from request events already in the log', async () => {
    const bus = new FakeEventBus();
    const request = {
      id: 'req-1',
      kind: 'approval',
      status: 'answered',
      title: 'Send email',
      summary: 'Send it',
      agentId: 'agt-1',
      createdAt: '2026-10-05T00:00:00.000Z',
      payload: { kind: 'approval', action: 'Send email', why: 'asked' },
      awakeableId: 'awk-secret',
      wakeDeliveredAt: '2026-10-05T00:00:01.000Z',
      resolution: { action: 'approve' },
    };
    for (const [id, type] of [[1, 'request.created'], [2, 'request.resolved']] as const) {
      bus.events.push({ id, event: { type, request } as AgentEvent, at: '2026-10-05T00:00:00.000Z' });
    }

    const text = await collect(await makeApp(bus).request('/v1/events', { headers: AUTH }), (t) => t.includes('id: 2'));

    expect(text).toContain('event: request.created');
    expect(text).toContain('event: request.resolved');
    expect(text).toContain('"id":"req-1"');
    expect(text).not.toContain('awakeableId');
    expect(text).not.toContain('awk-secret');
    expect(text).not.toContain('wakeDeliveredAt');
    expect(text).not.toContain('resolution');
  });

  it('replays a backlog larger than one page', async () => {
    const bus = new FakeEventBus();
    for (let id = 1; id <= 205; id += 1) bus.store(id);

    const app = makeApp(bus);
    const text = await collect(await app.request('/v1/events', { headers: AUTH }), (t) =>
      t.includes('id: 205')
    );

    expect(text).toContain('id: 205');
    expect(text.split('id: 1\n').length - 1).toBe(1);
  });

  it('buffers a live event published during the backlog read and sends it once', async () => {
    const bus = new FakeEventBus();
    bus.store(1);
    bus.store(2);
    bus.store(3);
    // Fires inside the first since(): the listener must already be attached, and the duplicate id 2
    // must not be emitted twice.
    bus.onNextSince = () => {
      bus.emitLive(2);
      bus.emitLive(4);
    };

    const app = makeApp(bus);
    const text = await collect(await app.request('/v1/events', { headers: AUTH }), (t) =>
      t.includes('id: 4')
    );

    expect(text).toContain('id: 2\n');
    expect(text.split('id: 2\n').length - 1).toBe(1);
    expect(text).toContain('id: 3\n');
    expect(text.match(/^id: \d+$/gm)).toEqual(['id: 1', 'id: 2', 'id: 3', 'id: 4']);
  });

  it('delivers a live event whose id is lower than one already sent (commit order differs from id order)', async () => {
    const bus = new FakeEventBus();
    bus.store(1);
    const response = await makeApp(bus).request('/v1/events', { headers: AUTH });
    await new Promise((r) => setTimeout(r, 100));
    bus.emitLive(17);
    bus.emitLive(15);

    const text = await collect(response, (t) => t.includes('id: 15\n'));
    expect(text.match(/^id: \d+$/gm)).toEqual(['id: 1', 'id: 17', 'id: 15']);
  });

  it('releases the installed subscription when backlog replay fails', async () => {
    const bus = new FakeEventBus();
    bus.replayError = new Error('backlog failed');
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const response = await makeApp(bus).request('/v1/events', { headers: AUTH });
    if (!response.body) throw new Error('response has no body');
    const reader = response.body.getReader();
    await expect(reader.read()).rejects.toThrow('backlog failed');
    expect(bus.released).toBe(1);
    expect(setSpy).not.toHaveBeenCalled();
    bus.emitLive(1);
  });

  it('resets only when the cursor fell behind the retained log', async () => {
    const stale = new FakeEventBus();
    stale.store(50);
    stale.store(51);
    const staleText = await collect(
      await makeApp(stale).request('/v1/events?after=10', { headers: AUTH }),
      (t) => t.includes('id: 51')
    );
    expect(staleText).toContain('event: reset');
    expect(staleText).toContain('id: 50');

    const contiguous = new FakeEventBus();
    contiguous.store(50);
    contiguous.store(51);
    const okText = await collect(
      await makeApp(contiguous).request('/v1/events?after=49', { headers: AUTH }),
      (t) => t.includes('id: 51')
    );
    expect(okText).not.toContain('event: reset');
    expect(okText).toContain('id: 50');
  });

  it('does not reset for normal sequence gaps within retained history', async () => {
    const bus = new FakeEventBus();
    bus.store(1);
    bus.store(3);
    const text = await collect(
      await makeApp(bus).request('/v1/events?after=1', { headers: AUTH }),
      (t) => t.includes('id: 3\n')
    );
    expect(text).not.toContain('event: reset');
    expect(text).toContain('id: 3\n');
    expect(text).not.toContain('id: 1\n');
  });

  it('releases a subscription that resolves after stream cancellation', async () => {
    const bus = new FakeEventBus();
    let resolveSubscription = () => {};
    bus.subscriptionReady = new Promise<void>((resolve) => {
      resolveSubscription = resolve;
    });
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const response = await makeApp(bus).request('/v1/events', { headers: AUTH });
    if (!response.body) throw new Error('response has no body');
    await response.body.cancel();
    expect(bus.released).toBe(0);
    resolveSubscription();
    await vi.waitFor(() => expect(bus.released).toBe(1));
    expect(setSpy).not.toHaveBeenCalled();
    bus.emitLive(1);
    expect(bus.released).toBe(1);
  });

  it('releases the subscription and clears the heartbeat on cancellation', async () => {
    const bus = new FakeEventBus();
    bus.store(1);

    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    const response = await makeApp(bus).request('/v1/events', { headers: AUTH });
    const body = response.body;
    if (!body) throw new Error('response has no body');
    const reader = body.getReader();
    const first = await reader.read();
    if (first.done) throw new Error('stream closed before the first event');
    expect(decoder.decode(first.value)).toContain('id: 1');

    // Let start() finish so the heartbeat is registered before we cancel.
    await new Promise((r) => setTimeout(r, 10));
    expect(setSpy).toHaveBeenCalledTimes(1);

    await reader.cancel();
    expect(bus.released).toBeGreaterThanOrEqual(1);
    expect(clearSpy).toHaveBeenCalledWith(setSpy.mock.results[0]?.value);
  });
});

describe('AG-UI reconnect synthesis', () => {
  const conversation = (id: string, createdAt: string): Conversation =>
    ({ id, kind: 'direct', agentIds: ['agent-1'], memberIds: ['owner-1'], unreadCount: 0, createdAt } as unknown as Conversation);
  const message = (id: string, conversationId: string, markdown: string, at: string): Item =>
    ({ id, conversationId, type: 'agent_message', agentId: 'agent-1', runId: 'run-1', markdown, citations: [], at });

  it('sends the authorized conversations at the head with whole-item attribution and no reused row id', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, 'owner-1');
    await seed.put('conversations', conversation('conv-one', '2026-10-01T00:00:00.000Z'));
    await seed.put('conversations', conversation('conv-two', '2026-10-02T00:00:00.000Z'));
    await seed.put('items', message('item-one', 'conv-one', 'First reply', '2026-10-01T00:00:01.000Z'));
    await seed.put('items', message('item-two', 'conv-two', 'Second reply', '2026-10-02T00:00:01.000Z'));
    const app = createTestApp({ store: raw, bus: new FakeEventBus(), enqueuer: new NoopEnqueuer() });
    const text = await collect(await app.request('/v1/events', { headers: AUTH }), (t) => t.includes('item-one') && t.includes('item-two'));

    expect(text.match(/event: MESSAGES_SNAPSHOT/g)).toHaveLength(2);
    expect(text).toContain('"conversationId":"conv-one"');
    expect(text).toContain('"conversationId":"conv-two"');
    expect(text).toContain('"item":{"id":"item-one"');
    expect(text).not.toMatch(/^id: /m);
  });

  it('restores a still-running conversation older than the bounded recent history', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, 'owner-1');
    for (let index = 0; index < 21; index += 1) {
      const id = 'conv-' + String(index).padStart(2, '0');
      await seed.put('conversations', conversation(id, '2026-10-' + String(index + 1).padStart(2, '0') + 'T00:00:00.000Z'));
    }
    await seed.put('items', message('old-item', 'conv-00', 'old but running', '2026-10-01T00:00:01.000Z'));
    await seed.put('runs', {
      id: 'run-old', agentId: 'agent-1', conversationId: 'conv-00', title: 'Old run', status: 'running', kind: 'chat', steps: [],
      usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      startedAt: '2026-10-01T00:00:00.000Z', lastActivityAt: '2026-10-01T00:00:00.000Z',
    } as never);
    const app = createTestApp({ store: raw, bus: new FakeEventBus(), enqueuer: new NoopEnqueuer() });
    const text = await collect(await app.request('/v1/events', { headers: AUTH }), (t) => t.includes('old but running'));
    expect(text).toContain('"conversationId":"conv-00"');
    expect(text).toContain('old but running');
  });

  it('keeps durable ids on durable frames only and synthesizes the snapshot without a cursor id', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, 'owner-1');
    await seed.put('conversations', conversation('conv-snap', '2026-10-01T00:00:00.000Z'));
    await seed.put('items', message('item-snap', 'conv-snap', 'Streamed paragraph', '2026-10-01T00:00:01.000Z'));
    const bus = new FakeEventBus();
    bus.store(5);
    const app = createTestApp({ store: raw, bus, enqueuer: new NoopEnqueuer() });
    const text = await collect(await app.request('/v1/events?after=4', { headers: AUTH }), (t) => t.includes('Streamed paragraph'));
    expect(text).toContain('"conversationId":"conv-snap"');
    // The synthesized snapshot never reuses the durable row id; only row 5 carries one.
    expect(text.match(/^id: /gm)).toHaveLength(1);
    expect(text.match(/^id: 5$/m)).not.toBeNull();
  });
});

describe('SSE auth', () => {
  // Browser CORS lives on the public API (packages/api cors.test.ts): this loopback service has none.

  it('requires a bearer token for /v1/events', async () => {
    const app = makeApp(new FakeEventBus());

    const unauthorized = await app.request('/v1/events');
    expect(unauthorized.status).toBe(401);

    const authorized = await app.request('/v1/events', { headers: AUTH });
    expect(authorized.status).toBe(200);
    if (authorized.body) await authorized.body.cancel();
  });

  it('keeps /healthz public', async () => {
    const res = await makeApp(new FakeEventBus()).request('/healthz');
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/events/cursor', () => {
  const cursorOf = async (app: ReturnType<typeof makeApp>): Promise<number> => {
    const res = await app.request('/v1/events/cursor', { headers: AUTH });
    expect(res.status).toBe(200);
    return ((await res.json()) as { after: number }).after;
  };

  it('answers head minus the margin, never below zero', async () => {
    const bus = new FakeEventBus();
    for (let id = 1; id <= 1000; id += 1) bus.store(id);
    expect(await cursorOf(makeApp(bus))).toBe(1000 - 200);

    const small = new FakeEventBus();
    for (let id = 1; id <= 50; id += 1) small.store(id);
    // Head 50 is inside the margin, so the floor is 0; the owner clamp (earliest 1 - 1 = 0) agrees.
    expect(await cursorOf(makeApp(small))).toBe(0);
    expect(await cursorOf(makeApp(new FakeEventBus()))).toBe(0);
  });

  it('requires a bearer token', async () => {
    const app = makeApp(new FakeEventBus());
    expect((await app.request('/v1/events/cursor')).status).toBe(401);
  });

  it('never starts below the owner\'s earliest event, so a young owner gets no reset', async () => {
    // Global ids: this owner's only history sits at 1000..1005, far above head - margin for a log of 5000.
    const bus = new FakeEventBus();
    for (let id = 1; id <= 4000; id += 1) bus.store(id);
    const earliestOwnerId = 3995;
    bus.events.splice(0, bus.events.length, ...bus.events.filter((e) => e.id >= earliestOwnerId));
    const after = await cursorOf(makeApp(bus));
    expect(after).toBe(earliestOwnerId - 1);

    const res = await makeApp(bus).request(`/v1/events?after=${after}`, { headers: AUTH });
    const text = await collect(res, (t) => t.includes('id: 4000'));
    expect(text).not.toContain('event: reset');
    expect(text).toContain('id: 4000');
  });
});
