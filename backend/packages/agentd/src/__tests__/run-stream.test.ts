/**
 * The voice bridge's push channel: GET /v1/conversations/:id/runs/:runId/stream on the production app. One stream carries a run's
 * live text, its reply items (a mid-run send_message included) and its end, so the bridge never polls the database.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { LiveRunEvent } from '@agent-desktop/contracts';
import { EventType, type Conversation, type Item } from '@agent-desktop/public-contracts';
import { emitItemAdded } from 'juno-agent/execution/conversation-activity';
import { createLiveRuns, type LiveRuns } from 'juno-agent/execution/live-runs';
import { wireLive } from '../live-wiring.js';
import { createTestApp, ownerHeaders, withDefaultOwner } from './test-app.js';

const OWNER = 'owner-1';
const CONV = 'conv-voice';
const RUN = 'run-voice';
const decoder = new TextDecoder();

const conversation = { id: CONV, kind: 'direct', agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, createdAt: '2026-11-04T00:00:00.000Z' } as unknown as Conversation;
const reply = (id: string, markdown: string, runId = RUN): Item => ({ id, conversationId: CONV, type: 'agent_message', agentId: 'agent-1', runId, markdown, citations: [], at: '2026-11-04T00:00:01.000Z' });
const live = (event: Partial<LiveRunEvent> & Pick<LiveRunEvent, 'type'>, scope: Partial<LiveRunEvent> = {}): LiveRunEvent =>
  ({ ownerId: OWNER, conversationId: CONV, agentId: 'agent-1', runId: RUN, attempt: 'model:0', ...event, ...scope }) as LiveRunEvent;

async function setup() {
  const raw = createMemoryStore();
  await withDefaultOwner(raw, OWNER).put('conversations', conversation);
  // Role `all`: one hub shared by the harness (here, the test publishing) and the HTTP stream; the bus carries no live text at all.
  const hub = createLiveRuns();
  const bus = { ...raw.eventBus, publishLive: () => { throw new Error('live text must not touch the cross-process transport'); }, subscribeLive: () => { throw new Error('live text must not touch the cross-process transport'); } };
  const app = createTestApp({ store: raw, bus, enqueuer: new NoopEnqueuer(), live: hub });
  const emitLive = async (_store: unknown, event: LiveRunEvent): Promise<void> => { hub.publish(event); };
  const open = (after = 0, runId = RUN) => app.request(`/v1/conversations/${CONV}/runs/${runId}/stream?after=${String(after)}`, { headers: ownerHeaders(OWNER) });
  return { raw, app, open, emitLive, hub };
}

/** A reader that collects frames until `until` matches, so a test can act between frames. */
function reader(response: Response) {
  const body = response.body;
  if (body === null) throw new Error('no body');
  const r = body.getReader();
  let text = '';
  return {
    async until(match: (text: string) => boolean, timeoutMs = 1000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (!match(text) && Date.now() < deadline) {
        const chunk = await Promise.race([r.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 20))]);
        if (chunk === null) continue;
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    },
    cancel: () => r.cancel(),
  };
}

const finished = (runId = RUN) => ({ type: EventType.RUN_FINISHED, threadId: CONV, runId, outcome: { type: 'success' } }) as const;

describe('GET /v1/conversations/:id/runs/:runId/stream', () => {
  it('says ready, then pushes live text (from the in-process hub, never the bus transport), a mid-run send_message item and the end of the run in order, and closes', async () => {
    const { raw, open, emitLive } = await setup();
    const frames = reader(await open());
    await frames.until((t) => t.includes('event: ready'));
    await emitLive(raw, live({ type: 'run.text.reset' }));
    await emitLive(raw, live({ type: 'run.text.delta', text: 'Checking. ' } as LiveRunEvent));
    await emitLive(raw, live({ type: 'run.text.end', toolCalls: 1 } as LiveRunEvent));
    const seeded = withDefaultOwner(raw, OWNER);
    await seeded.put('items', reply('ack', 'On it.'));
    await emitItemAdded(seeded, CONV, reply('ack', 'On it.'));
    await seeded.emit(finished());
    const text = await frames.until((t) => t.includes('event: RUN_FINISHED'));

    const order = ['event: ready', 'event: run.text.reset', '"text":"Checking. "', 'event: run.text.end', '"markdown":"On it."', 'event: RUN_FINISHED'].map((needle) => text.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await frames.cancel();
  });

  it('a stream opened after the run started gets the live text already written, after ready', async () => {
    const { raw, open, emitLive } = await setup();
    await emitLive(raw, live({ type: 'run.text.reset' }));
    await emitLive(raw, live({ type: 'run.text.delta', text: 'Already said. ' } as LiveRunEvent));
    const frames = reader(await open());
    const text = await frames.until((t) => t.includes('Already said.'));
    expect(text.indexOf('event: ready')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('event: ready')).toBeLessThan(text.indexOf('Already said.'));
    await frames.cancel();
  });

  it('replays this run\'s durable events after the cursor and ends the stream at the run end', async () => {
    const { raw, open, emitLive } = await setup();
    const seeded = withDefaultOwner(raw, OWNER);
    await emitItemAdded(seeded, CONV, reply('mine', 'answer'));
    await emitItemAdded(seeded, CONV, reply('other', 'someone else\'s', 'run-other'));
    await seeded.emit(finished());
    const response = await open();
    const text = await response.text();

    expect(text).toContain('"markdown":"answer"');
    expect(text).toContain('event: RUN_FINISHED');
    expect(text).not.toContain('someone else');
  });

  it('forwards nothing of another run or another owner', async () => {
    const { raw, open, emitLive } = await setup();
    const frames = reader(await open());
    await frames.until((t) => t.includes('event: ready'));
    await emitLive(raw, live({ type: 'run.text.delta', text: 'other run' } as LiveRunEvent, { runId: 'run-other' }));
    await emitLive(raw, live({ type: 'run.text.delta', text: 'other owner' } as LiveRunEvent, { ownerId: 'owner-2' }));
    await emitLive(raw, live({ type: 'run.text.delta', text: 'mine' } as LiveRunEvent));
    const text = await frames.until((t) => t.includes('mine'));
    expect(text).toContain('mine');
    expect(text).not.toContain('other run');
    expect(text).not.toContain('other owner');
    await frames.cancel();
  });

  it('releases both subscriptions when the client goes away', async () => {
    const raw = createMemoryStore();
    await withDefaultOwner(raw, OWNER).put('conversations', conversation);
    const hub = createLiveRuns();
    let live = 0;
    let durable = 0;
    const counted: LiveRuns = { publish: hub.publish, subscribe: (filter, onEvent) => { live += 1; const off = hub.subscribe(filter, onEvent); return () => { live -= 1; off(); }; } };
    const bus = {
      ...raw.eventBus,
      forOwner: () => bus,
      subscribe: async (onEvent: Parameters<typeof raw.eventBus.subscribe>[0]) => { durable += 1; const off = await raw.eventBus.subscribe(onEvent); return () => { durable -= 1; off(); }; },
    };
    const app = createTestApp({ store: raw, bus, enqueuer: new NoopEnqueuer(), live: counted });
    const frames = reader(await app.request(`/v1/conversations/${CONV}/runs/${RUN}/stream?after=0`, { headers: ownerHeaders(OWNER) }));
    await frames.until((t) => t.includes('event: ready'));
    expect([live, durable]).toEqual([1, 1]);
    await frames.cancel();
    expect([live, durable]).toEqual([0, 0]);
  });

  it('refuses a conversation the owner cannot see and a malformed cursor', async () => {
    const { app, open } = await setup();
    const foreign = await app.request(`/v1/conversations/${CONV}/runs/${RUN}/stream?after=0`, { headers: ownerHeaders('owner-2') });
    expect(foreign.status).toBe(404);
    expect((await open(-1)).status).toBe(400);
    const noAuth = await app.request(`/v1/conversations/${CONV}/runs/${RUN}/stream?after=0`);
    expect(noAuth.status).toBe(401);
  });
});

describe('live text wiring by agentd role', () => {
  const bus = (calls: string[]) => {
    const raw = createMemoryStore();
    const relay: Array<(e: LiveRunEvent) => void> = [];
    return {
      raw,
      bus: {
        ...raw.eventBus,
        publishLive: async (batch: LiveRunEvent[]) => { calls.push('publishLive'); for (const event of batch) relay.forEach((cb) => cb(event)); },
        subscribeLive: async (cb: (e: LiveRunEvent) => void) => { calls.push('subscribeLive'); relay.push(cb); return () => undefined; },
      },
    };
  };

  it('role all: the runner\'s sink IS the stream\'s hub, so text reaches the stream route with no database transport at all', async () => {
    const calls: string[] = [];
    const { raw, bus: transport } = bus(calls);
    await withDefaultOwner(raw, OWNER).put('conversations', conversation);
    const wired = await wireLive(transport, { coordinator: true, executes: true });
    const app = createTestApp({ store: raw, bus: transport, enqueuer: new NoopEnqueuer(), live: wired.live });
    const frames = reader(await app.request(`/v1/conversations/${CONV}/runs/${RUN}/stream?after=0`, { headers: ownerHeaders(OWNER) }));
    await frames.until((t) => t.includes('event: ready'));
    wired.sink.publish(live({ type: 'run.text.delta', text: 'straight through' } as LiveRunEvent));
    expect(await frames.until((t) => t.includes('straight through'))).toContain('straight through');
    await frames.cancel();
    await wired.stop();
    expect(calls).toEqual([]);
  });

  it('split roles: a worker publishes coalesced batches over the transport and the coordinator relays them into the hub the stream reads', async () => {
    const calls: string[] = [];
    const { raw, bus: transport } = bus(calls);
    await withDefaultOwner(raw, OWNER).put('conversations', conversation);
    const coordinator = await wireLive(transport, { coordinator: true, executes: false });
    const worker = await wireLive(transport, { coordinator: false, executes: true });
    const app = createTestApp({ store: raw, bus: transport, enqueuer: new NoopEnqueuer(), live: coordinator.live });
    const frames = reader(await app.request(`/v1/conversations/${CONV}/runs/${RUN}/stream?after=0`, { headers: ownerHeaders(OWNER) }));
    await frames.until((t) => t.includes('event: ready'));
    for (const token of ['one ', 'two ', 'three']) worker.sink.publish(live({ type: 'run.text.delta', text: token } as LiveRunEvent));
    await worker.stop();
    const text = await frames.until((t) => t.includes('one two three'));
    expect(text).toContain('one two three');
    expect(calls.filter((call) => call === 'publishLive')).toHaveLength(1);
    await frames.cancel();
  });
});
